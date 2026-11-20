import { describe, expect, it } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer, isLoopbackHost, type RunningServer } from '../src/web/server.js';
import { projectsDir } from '../src/web/store.js';
import { writePackage } from '../src/package/index.js';
import { makeTimelineData, tempDir } from './helpers/fixtures.js';

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  running: RunningServer,
  target: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: running.port,
        path: target,
        method: options.method ?? 'GET',
        headers: {
          Host: `127.0.0.1:${running.port}`,
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk as Buffer));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

async function withServer(
  options: Parameters<typeof startServer>[0],
  fn: (running: RunningServer) => Promise<void>,
): Promise<void> {
  const running = await startServer(options);
  try {
    await fn(running);
  } finally {
    await running.close();
  }
}

async function dataDir(): Promise<string> {
  return tempDir('aitimeline-web-sec-');
}

describe('web server security', () => {
  it('binds loopback by default and sends conservative security headers', async () => {
    const dir = await dataDir();
    await withServer({ dataDir: dir, port: 0 }, async (running) => {
      const address = running.server.address();
      expect(typeof address === 'object' && address?.address).toBe('127.0.0.1');
      const health = await request(running, '/api/health');
      expect(health.status).toBe(200);
      const parsed = JSON.parse(health.body) as Record<string, unknown>;
      expect(parsed.dataDir).toBeUndefined();
      expect(parsed.loopback).toBe(true);
      expect(health.headers['access-control-allow-origin']).toBeUndefined();
      expect(health.headers['x-content-type-options']).toBe('nosniff');
      expect(health.headers['x-frame-options']).toBe('DENY');
    });
  });

  it('refuses a non-loopback bind without explicit acknowledgement', async () => {
    const dir = await dataDir();
    await expect(startServer({ dataDir: dir, host: '0.0.0.0', port: 0 }))
      .rejects.toThrow(/Refusing to bind non-loopback/);
    await expect(startServer({ dataDir: dir, host: '192.168.1.50', port: 0 }))
      .rejects.toThrow(/Refusing to bind non-loopback/);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('10.0.0.5')).toBe(false);
  });

  it('requires a token when non-loopback binding is explicitly allowed', async () => {
    const dir = await dataDir();
    await withServer({ dataDir: dir, host: '0.0.0.0', port: 0, allowRemote: true }, async (running) => {
      expect(running.token).toBeTruthy();
      expect(running.token!.length).toBeGreaterThanOrEqual(16);
      const denied = await request(running, '/api/health');
      expect(denied.status).toBe(401);
      expect(denied.headers['www-authenticate']).toMatch(/Bearer/);
      expect(denied.body).not.toContain(running.token!);

      const allowed = await request(running, '/api/health', {
        headers: { Authorization: `Bearer ${running.token}` },
      });
      expect(allowed.status).toBe(200);
      const parsed = JSON.parse(allowed.body) as Record<string, unknown>;
      expect(parsed.auth).toBe('token');
    });
  });

  it('exchanges a URL token for an HttpOnly SameSite cookie and serves the UI', async () => {
    const dir = await dataDir();
    await withServer(
      { dataDir: dir, port: 0, authToken: 'test-token-0123456789' },
      async (running) => {
        const redirect = await request(running, '/?token=test-token-0123456789');
        expect(redirect.status).toBe(303);
        const cookie = String(redirect.headers['set-cookie'] ?? '');
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('SameSite=Strict');
        expect(cookie).not.toContain('Secure');

        const html = await request(running, '/', {
          headers: { Cookie: 'aitimeline_token=test-token-0123456789' },
        });
        expect(html.status).toBe(200);
        expect(html.headers['content-security-policy']).toContain("frame-ancestors 'none'");
        expect(html.headers['x-frame-options']).toBe('DENY');
      },
    );
  });

  it('rejects DNS-rebinding Host headers on a loopback bind', async () => {
    const dir = await dataDir();
    await withServer({ dataDir: dir, port: 0 }, async (running) => {
      const rebound = await request(running, '/api/health', {
        headers: { Host: 'attacker.example:80' },
      });
      expect(rebound.status).toBe(403);
      const local = await request(running, '/api/health', {
        headers: { Host: `localhost:${running.port}` },
      });
      expect(local.status).toBe(200);
    });
  });

  it('rejects cross-origin state changes (CSRF)', async () => {
    const dir = await dataDir();
    await withServer({ dataDir: dir, port: 0 }, async (running) => {
      const response = await request(running, '/api/config', {
        method: 'POST',
        headers: {
          Origin: 'http://evil.example',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ contentMode: 'full' }),
      });
      expect(response.status).toBe(403);
      const sameOrigin = await request(running, '/api/config', {
        method: 'POST',
        headers: {
          Origin: `http://127.0.0.1:${running.port}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ contentMode: 'summary' }),
      });
      expect(sameOrigin.status).toBe(200);
    });
  });

  it('rejects non-JSON and malformed bodies without crashing', async () => {
    const dir = await dataDir();
    await withServer({ dataDir: dir, port: 0 }, async (running) => {
      const plain = await request(running, '/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{"contentMode":"full"}',
      });
      expect(plain.status).toBe(415);
      const malformed = await request(running, '/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not-json',
      });
      expect(malformed.status).toBe(400);
      expect(malformed.body).not.toContain(dir);
      const array = await request(running, '/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '[]',
      });
      expect(array.status).toBe(400);
      expect((await request(running, '/api/health')).status).toBe(200);
    });
  });

  it('rejects path traversal and never serves arbitrary files', async () => {
    const dir = await dataDir();
    await withServer({ dataDir: dir, port: 0 }, async (running) => {
      const encoded = await request(running, '/api/project/%2e%2e%2f%2e%2e%2fetc%2fpasswd/detail');
      expect(encoded.status).toBe(400);
      expect(encoded.body).not.toContain('root:');
      const plain = await request(running, '/api/project/../../../../etc/passwd/export');
      expect([400, 404]).toContain(plain.status);
      expect(plain.body).not.toContain('root:');
      const dotdot = await request(running, '/api/project/../detail');
      expect([400, 404]).toContain(dotdot.status);
      // A valid-looking id that does not exist is a 404, never a filesystem read.
      const missing = await request(running, '/api/project/proj_does_not_exist_123/export');
      expect(missing.status).toBe(404);
    });
  });

  it('returns 405 with an Allow header for unsupported methods', async () => {
    const dir = await dataDir();
    await withServer({ dataDir: dir, port: 0 }, async (running) => {
      const put = await request(running, '/api/health', { method: 'PUT' });
      expect(put.status).toBe(405);
      expect(put.headers.allow).toBe('GET, POST');
      const postHealth = await request(running, '/api/health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(postHealth.status).toBe(405);
      expect(postHealth.headers.allow).toBe('GET');
      const deleteConfig = await request(running, '/api/config', { method: 'DELETE' });
      expect(deleteConfig.status).toBe(405);
    });
  });

  it('validates scan inputs and never leaks absolute paths in errors', async () => {
    const dir = await dataDir();
    await withServer({ dataDir: dir, port: 0 }, async (running) => {
      const missing = await request(running, '/api/scan/project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(missing.status).toBe(400);
      const traversal = await request(running, '/api/scan/project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: '../../etc' }),
      });
      expect(traversal.status).toBe(400);
      expect(traversal.body).not.toContain(dir);
      const unknown = await request(running, '/api/scan/project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'repo_unknown123' }),
      });
      expect(unknown.status).toBe(404);

      const relativeRoot = await request(running, '/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roots: ['relative/path'] }),
      });
      expect(relativeRoot.status).toBe(400);
      expect(relativeRoot.body).not.toContain(dir);

      const notDirectory = await request(running, '/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roots: [path.join(dir, 'missing-root')] }),
      });
      expect(notDirectory.status).toBe(400);
      expect(notDirectory.body).not.toContain(dir);
    });
  });

  it('returns a generic 500 for unreadable packages and closes with open keep-alive sockets', async () => {
    const dir = await dataDir();
    const projectId = 'repo_broken0001';
    const packageDir = path.join(projectsDir(dir), projectId);
    await mkdir(packageDir, { recursive: true });
    await writePackage(packageDir, makeTimelineData({
      manifest: { ...makeTimelineData().manifest, project_id: 'proj_broken', timeline_id: 'tln_broken' },
    }));
    await writeFile(path.join(packageDir, 'manifest.json'), '{not json');

    const running = await startServer({ dataDir: dir, port: 0 });
    const agent = new http.Agent({ keepAlive: true });
    try {
      const response = await new Promise<Reply>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: running.port,
            path: `/api/project/${projectId}/detail`,
            headers: { Host: `127.0.0.1:${running.port}` },
            agent,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(chunk as Buffer));
            res.on('end', () => resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }));
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(response.status).toBe(500);
      expect(response.body).toBe(JSON.stringify({ error: 'internal server error' }));
      expect(response.body).not.toContain(dir);
    } finally {
      const closed = await Promise.race([
        running.close().then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
      ]);
      agent.destroy();
      expect(closed).toBe(true);
    }
    await expect(request(running, '/api/health')).rejects.toThrow();
  });
});
