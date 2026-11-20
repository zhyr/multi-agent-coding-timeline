/**
 * Interactive local web app — HTTP server.
 *
 * Uses only Node built-ins. Binds to loopback by default. Non-loopback binding
 * is refused unless explicitly allowed AND an access token is configured; the
 * server never exposes an unauthenticated remote interface. All git operations
 * are read-only; all writes go to the local data directory. The scanner core
 * (runScan) is reused unchanged — this server is another front end over it.
 */
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { runScan } from '../scan/engine.js';
import { UsageError, errorMessage } from '../core/errors.js';
import { inspectPath } from '../core/fs.js';
import { loadViewerModel, buildDetailPage, eventTypes, agentOptions, sessionSegments } from './detail.js';
import { exportJsonl, exportZip, lineAllowed, type ExportFormat } from './export.js';

/** Web app version (kept local to avoid a circular import with the CLI layer). */
const WEB_VERSION = '1.0.0';
import { discoverRepositories, defaultScanRoots, type RepositoryEntry } from './discovery.js';
import {
  defaultDataDir, loadConfig, saveConfig, loadCatalog, saveDiscoveredRepositories,
  markScanned, hasPackage, projectOutputDir, stateDir, ensureLayout, assertSafeProjectId,
  type WebConfig, type Catalog,
} from './store.js';
import {
  createJob, getJob, emit, subscribe, snapshot, pruneJobs,
  type Job, type ScanReposResult, type ScanProjectResult,
} from './jobs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** UI asset path: dist/web/ui.html after build, src/web/ui.html in dev. */
const UI_HTML_CANDIDATES = [
  path.join(__dirname, 'ui.html'),
  path.join(__dirname, '..', '..', 'src', 'web', 'ui.html'),
];

const MAX_URL_LENGTH = 8192;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_QUERY_TEXT = 200;

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

export interface ServeOptions {
  host?: string;
  port?: number;
  dataDir?: string;
  /**
   * Explicit acknowledgement required to bind a non-loopback interface.
   * Without it, startServer refuses to start.
   */
  allowRemote?: boolean;
  /**
   * Access token for non-loopback mode. Generated when omitted. Must be at
   * least 16 characters when supplied.
   */
  authToken?: string;
}

/** True for 127.0.0.0/8, ::1 and localhost. Everything else is remote. */
export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  if (value === 'localhost' || value === '::1' || value === '[::1]') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) return true;
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) return true;
  return false;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

function securityHeaders(res: ServerResponse, html = false): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (html) res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
}

function respond(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  securityHeaders(res);
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader('Allow', allow);
  respond(res, 405, { error: 'method not allowed' });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!type.startsWith('application/json')) {
    throw new HttpError(415, 'content-type must be application/json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large');
    chunks.push(buf);
  }
  if (!chunks.length) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

async function serveUi(res: ServerResponse): Promise<void> {
  const fs = await import('node:fs/promises');
  for (const candidate of UI_HTML_CANDIDATES) {
    try {
      const html = await fs.readFile(candidate);
      securityHeaders(res, true);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': html.length,
        'Cache-Control': 'no-store',
      });
      res.end(html);
      return;
    } catch { /* try next */ }
  }
  securityHeaders(res);
  res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('UI asset not found. Run `npm run build`.');
}

function sseHeaders(res: ServerResponse): void {
  securityHeaders(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

function sseWrite(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function expandPath(raw: string): string {
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

function redactError(error: unknown, dataDir: string): string {
  let message = errorMessage(error);
  if (dataDir) message = message.split(dataDir).join('<data-dir>');
  const home = os.homedir();
  if (home) message = message.split(home).join('~');
  // Job errors are shown in the UI; never surface arbitrary absolute paths.
  message = message.replace(/\/[^\s'",;:]+/g, '<path>');
  return message.slice(0, 300);
}

async function validatedRoots(value: unknown): Promise<string[]> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw new HttpError(400, 'roots must be a non-empty array (max 50)');
  }
  const roots: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') throw new HttpError(400, 'each root must be a string');
    const root = expandPath(raw.trim());
    if (!root || root.length > 4096) throw new HttpError(400, 'root path is empty or too long');
    if (!path.isAbsolute(root)) throw new HttpError(400, 'roots must be absolute paths');
    const info = await inspectPath(root);
    if (!info.exists || !info.isDirectory || !info.readable) {
      throw new HttpError(400, `root is not a readable directory: ${path.basename(root)}`);
    }
    roots.push(root);
  }
  return roots;
}

function projectIdFrom(raw: string | undefined): string {
  if (!raw) throw new HttpError(400, 'invalid project id');
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, 'invalid project id');
  }
  try {
    return assertSafeProjectId(decoded);
  } catch {
    throw new HttpError(400, 'invalid project id');
  }
}

function limitedParam(url: URL, name: string): string {
  const value = url.searchParams.get(name) ?? '';
  return value.length > MAX_QUERY_TEXT ? value.slice(0, MAX_QUERY_TEXT) : value;
}

function numericParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw == null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** Start a level-1 discovery scan in the background. */
async function startReposScan(dataDir: string, keyword: string): Promise<Job> {
  const job = createJob('scan-repos');
  (async () => {
    try {
      const config = await loadConfig(dataDir);
      const roots = config.roots.length ? config.roots : defaultScanRoots();
      const repositories = await discoverRepositories({
        roots,
        keyword,
        onProgress: (done, total, message) => {
          emit(job, { type: 'progress', progress: total ? Math.round((done / total) * 100) : 0, message });
        },
      });
      const catalog = await saveDiscoveredRepositories(dataDir, repositories, { ...config, lastKeyword: keyword });
      const result: ScanReposResult = { repositories: catalog.repositories, total: catalog.repositories.length, keyword };
      emit(job, { type: 'done', progress: 100, message: `发现 ${catalog.repositories.length} 个仓库`, data: result });
    } catch (error) {
      emit(job, { type: 'error', message: redactError(error, dataDir) });
    }
  })();
  return job;
}

/** Start a level-2 project scan in the background. */
async function startProjectScan(dataDir: string, projectId: string): Promise<Job> {
  const job = createJob('scan-project');
  (async () => {
    try {
      const catalog = await loadCatalog(dataDir);
      const entry = catalog?.repositories.find((r) => r.id === projectId);
      if (!entry) throw new Error('Unknown project id');

      const config = await loadConfig(dataDir);
      const output = projectOutputDir(dataDir, projectId);
      const hadPackage = await hasPackage(dataDir, projectId);

      const outcome = await runScan({
        project: entry.path,
        output,
        contentMode: config.contentMode,
        force: true,
        stateDir: stateDir(dataDir),
        onProgress: (message) => emit(job, { type: 'progress', message }),
      });

      const eventCount = outcome.data.events.length;
      await markScanned(dataDir, projectId, eventCount);
      const result: ScanProjectResult = { projectId, eventCount, reused: hadPackage };
      emit(job, { type: 'done', progress: 100, message: `扫描完成：${eventCount} 个事件`, data: result });
    } catch (error) {
      emit(job, { type: 'error', message: redactError(error, dataDir) });
    }
  })();
  return job;
}

export interface RunningServer {
  server: http.Server;
  close: () => Promise<void>;
  /** Access token, present when token authentication is enabled. */
  token?: string;
  host: string;
  port: number;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

export async function startServer(options: ServeOptions = {}): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8766;
  const dataDir = options.dataDir ?? defaultDataDir();
  const loopback = isLoopbackHost(host);

  if (!loopback && !options.allowRemote) {
    throw new UsageError(
      `Refusing to bind non-loopback host ${host}. The web app can scan and export local agent data. ` +
        'Pass --allow-remote AND configure --auth-token (or let a token be generated) to expose it deliberately.',
    );
  }
  let token: string | undefined;
  if (!loopback || options.authToken) {
    token = options.authToken?.trim() || randomBytes(24).toString('hex');
    if (token.length < 16) throw new UsageError('auth token must be at least 16 characters');
  }

  await ensureLayout(dataDir);

  let actualPort = port;
  let allowedHostHeaders = new Set<string>();
  const localNames = new Set<string>(['localhost', '127.0.0.1', '[::1]']);
  if (host.startsWith('127.')) localNames.add(host.toLowerCase());
  if (host.toLowerCase() === '::1') localNames.add('[::1]');
  if (host.toLowerCase() === 'localhost') localNames.add('localhost');

  const buildHostAllowlist = (boundPort: number) => {
    const set = new Set<string>();
    for (const name of localNames) {
      set.add(name);
      set.add(`${name}:${boundPort}`);
    }
    return set;
  };

  const sockets = new Set<Socket>();
  const server = http.createServer(async (req, res) => {
    // Lazy job pruning keeps memory bounded without a background timer
    // (the core library contract forbids background watchers/timers).
    pruneJobs();
    try {
      if ((req.url ?? '').length > MAX_URL_LENGTH) {
        respond(res, 414, { error: 'request URL too long' });
        return;
      }
      const hostHeader = String(req.headers.host ?? '').toLowerCase();
      if (!hostHeader) {
        respond(res, 403, { error: 'missing Host header' });
        return;
      }
      // Loopback binds are only reachable through local hostnames. This blocks
      // DNS-rebinding attacks that point an attacker domain at 127.0.0.1.
      if (loopback && !allowedHostHeaders.has(hostHeader)) {
        respond(res, 403, { error: 'unexpected Host header' });
        return;
      }

      const origin = req.headers.origin;
      if (origin) {
        let originHost = '';
        try {
          originHost = new URL(String(origin)).host.toLowerCase();
        } catch {
          respond(res, 403, { error: 'invalid Origin header' });
          return;
        }
        const sameHost = loopback ? allowedHostHeaders.has(originHost) : originHost === hostHeader;
        if (!sameHost) {
          respond(res, 403, { error: 'cross-origin request rejected' });
          return;
        }
      }
      if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') {
        respond(res, 403, { error: 'cross-site request rejected' });
        return;
      }

      if (req.method !== 'GET' && req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        respond(res, 405, { error: 'method not allowed' });
        return;
      }

      const url = new URL(req.url ?? '/', `http://${hostHeader || 'localhost'}`);
      const { pathname } = url;

      if (token) {
        const queryToken = url.searchParams.get('token') ?? undefined;
        const provided =
          bearerToken(req) ??
          (typeof req.headers['x-aitimeline-token'] === 'string' ? req.headers['x-aitimeline-token'] : undefined) ??
          queryToken ??
          cookieValue(req, 'aitimeline_token');
        if (!provided || !constantTimeEqual(provided, token)) {
          respond(res, 401, { error: 'unauthorized' }, {
            'WWW-Authenticate': 'Bearer realm="aitimeline"',
          });
          return;
        }
        // A token in the URL is exchanged for an HttpOnly SameSite cookie so it
        // does not linger in history or Referer headers.
        if (queryToken && constantTimeEqual(queryToken, token) && req.method === 'GET' && pathname === '/') {
          respond(res, 303, { status: 'redirecting' }, {
            Location: '/',
            'Set-Cookie': `aitimeline_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800`,
          });
          return;
        }
      }

      if (pathname === '/favicon.ico') {
        if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
        securityHeaders(res);
        res.writeHead(204); res.end(); return;
      }
      if (pathname === '/' || pathname === '/index.html') {
        if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
        await serveUi(res); return;
      }
      if (pathname === '/api/health') {
        if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
        respond(res, 200, {
          status: 'ok',
          version: WEB_VERSION,
          loopback,
          auth: token ? 'token' : 'none',
        });
        return;
      }
      if (pathname === '/api/config') {
        if (req.method === 'GET') {
          respond(res, 200, await loadConfig(dataDir)); return;
        }
        if (req.method !== 'POST') return methodNotAllowed(res, 'GET, POST');
        const body = await readJson(req);
        const config = await loadConfig(dataDir);
        if (Array.isArray(body.roots)) {
          config.roots = await validatedRoots(body.roots);
        } else if ('roots' in body) {
          throw new HttpError(400, 'roots must be an array');
        }
        if (body.contentMode === 'metadata_only' || body.contentMode === 'summary' || body.contentMode === 'full') {
          config.contentMode = body.contentMode;
        }
        await saveConfig(dataDir, config);
        respond(res, 200, config); return;
      }
      if (pathname === '/api/catalog') {
        if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
        const catalog = await loadCatalog(dataDir);
        respond(res, 200, catalog ?? { version: 1, updatedAt: null, config: await loadConfig(dataDir), repositories: [] });
        return;
      }
      if (pathname === '/api/scan/repos') {
        if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
        const body = await readJson(req);
        const keyword = typeof body.keyword === 'string'
          ? body.keyword.slice(0, MAX_QUERY_TEXT)
          : '';
        const job = await startReposScan(dataDir, keyword);
        respond(res, 200, { job_id: job.id }); return;
      }
      if (pathname === '/api/scan/project') {
        if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
        const body = await readJson(req);
        if (typeof body.projectId !== 'string') throw new HttpError(400, 'projectId is required');
        const projectId = projectIdFrom(body.projectId);
        const catalog = await loadCatalog(dataDir);
        if (!catalog?.repositories.some((entry) => entry.id === projectId)) {
          throw new HttpError(404, 'unknown project id');
        }
        const job = await startProjectScan(dataDir, projectId);
        respond(res, 200, { job_id: job.id }); return;
      }

      const jobEvents = pathname.match(/^\/api\/jobs\/([^/]+)\/events$/);
      if (jobEvents) {
        if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
        const job = getJob(jobEvents[1]);
        if (!job) { respond(res, 404, { error: 'job not found' }); return; }
        sseHeaders(res);
        for (const event of job.events) sseWrite(res, event);
        if (job.status === 'running') {
          const unsubscribe = subscribe(job, (event) => sseWrite(res, event));
          const cleanup = () => unsubscribe();
          req.on('close', cleanup);
          res.on('close', cleanup);
        } else {
          res.end();
        }
        return;
      }

      const jobGet = pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (jobGet) {
        if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
        const job = getJob(jobGet[1]);
        if (!job) { respond(res, 404, { error: 'job not found' }); return; }
        respond(res, 200, snapshot(job)); return;
      }

      const detail = pathname.match(/^\/api\/project\/([^/]+)\/detail$/);
      if (detail) {
        if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
        const projectId = projectIdFrom(detail[1]);
        if (!await hasPackage(dataDir, projectId)) {
          respond(res, 404, { error: 'project not scanned yet' }); return;
        }
        const loaded = await loadViewerModel(dataDir, projectId);
        if (!loaded) {
          respond(res, 422, { error: 'package unreadable or empty' }); return;
        }
        const page = buildDetailPage(loaded, {
          q: limitedParam(url, 'q'),
          type: limitedParam(url, 'type'),
          evidence: limitedParam(url, 'evidence'),
          agent: limitedParam(url, 'agent'),
          device: limitedParam(url, 'device'),
          session: limitedParam(url, 'session'),
          offset: numericParam(url, 'offset', 0),
          limit: numericParam(url, 'limit', 200),
        });
        respond(res, 200, {
          ...page,
          types: eventTypes(loaded),
          agentOptions: agentOptions(loaded),
        }); return;
      }

      const segments = pathname.match(/^\/api\/project\/([^/]+)\/segments$/);
      if (segments) {
        if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
        const projectId = projectIdFrom(segments[1]);
        if (!await hasPackage(dataDir, projectId)) {
          respond(res, 404, { error: 'project not scanned yet' }); return;
        }
        const loaded = await loadViewerModel(dataDir, projectId);
        if (!loaded) {
          respond(res, 422, { error: 'package unreadable or empty' }); return;
        }
        const page = sessionSegments(loaded, {
          q: limitedParam(url, 'q'),
          type: limitedParam(url, 'type'),
          evidence: limitedParam(url, 'evidence'),
          agent: limitedParam(url, 'agent'),
          device: limitedParam(url, 'device'),
          session: limitedParam(url, 'session'),
          offset: numericParam(url, 'offset', 0),
          limit: numericParam(url, 'limit', 200),
        });
        respond(res, 200, page); return;
      }

      const exportMatch = pathname.match(/^\/api\/project\/([^/]+)\/export$/);
      if (exportMatch) {
        if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
        const projectId = projectIdFrom(exportMatch[1]);
        const fmt = (url.searchParams.get('format') ?? 'jsonl') as ExportFormat;
        if (fmt !== 'jsonl' && fmt !== 'zip') {
          respond(res, 400, { error: 'format must be jsonl or zip' }); return;
        }
        if (!await hasPackage(dataDir, projectId)) {
          respond(res, 404, { error: 'project not scanned yet' }); return;
        }
        if (fmt === 'jsonl') {
          const exported = await exportJsonl(dataDir, projectId);
          if (!exported) { respond(res, 404, { error: 'events not found' }); return; }
          securityHeaders(res);
          res.writeHead(200, {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Content-Disposition': `attachment; filename="${exported.filename}"`,
            'Cache-Control': 'no-store',
          });
          // Stream line-by-line, dropping blocked-token lines; do not buffer 280MB in memory.
          let carry = '';
          const source = exported.stream;
          source.on('data', (chunk: Buffer | string) => {
            carry += chunk.toString();
            const parts = carry.split('\n');
            carry = parts.pop() ?? '';
            for (const line of parts) {
              if (lineAllowed(line)) res.write(line + '\n');
            }
          });
          source.on('end', () => {
            if (carry && lineAllowed(carry)) res.write(carry + '\n');
            res.end();
          });
          source.on('error', () => { if (!res.writableEnded) res.end(); });
          return;
        }
        // zip
        try {
          const exported = await exportZip(dataDir, projectId);
          if (!exported) { respond(res, 404, { error: 'package not found' }); return; }
          const { size } = await import('node:fs/promises').then((fs) => fs.stat(exported.file));
          securityHeaders(res);
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${exported.filename}"`,
            'Content-Length': size,
            'Cache-Control': 'no-store',
          });
          const stream = createReadStream(exported.file);
          stream.pipe(res);
          const cleanup = () => { void unlink(exported.file).catch(() => {}); };
          res.on('close', cleanup);
          stream.on('error', () => { if (!res.writableEnded) res.end(); });
        } catch {
          respond(res, 500, { error: 'zip export failed' });
        }
        return;
      }

      respond(res, 404, { error: 'not found' });
    } catch (error) {
      if (error instanceof HttpError) {
        respond(res, error.status, { error: error.message });
        return;
      }
      // Never leak absolute paths or internal details to an HTTP client.
      respond(res, 500, { error: 'internal server error' });
    }
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  actualPort = (server.address() as AddressInfo).port;
  allowedHostHeaders = buildHostAllowlist(actualPort);

  return {
    server,
    token,
    host,
    port: actualPort,
    close: async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}
