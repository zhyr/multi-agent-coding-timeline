/**
 * Interactive local web app — HTTP server.
 *
 * Uses only Node built-ins. Binds to loopback by default. All git operations
 * are read-only; all writes go to the local data directory. The scanner core
 * (runScan) is reused unchanged — this server is another front end over it.
 */
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { runScan } from '../scan/engine.js';
import { loadViewerModel, buildDetailPage, eventTypes, agentOptions } from './detail.js';
import { exportJsonl, exportZip, lineAllowed, type ExportFormat } from './export.js';

/** Web app version (kept local to avoid a circular import with the CLI layer). */
const WEB_VERSION = '1.0.0';
import { discoverRepositories, repoIdFromPath, defaultScanRoots, type RepositoryEntry } from './discovery.js';
import {
  defaultDataDir, loadConfig, saveConfig, loadCatalog, saveDiscoveredRepositories,
  markScanned, hasPackage, projectOutputDir, stateDir, ensureLayout,
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

export interface ServeOptions {
  host?: string;
  port?: number;
  dataDir?: string;
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 1024 * 1024) throw new Error('request body too large');
    chunks.push(buf);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function contentType(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
}

async function serveUi(res: ServerResponse): Promise<void> {
  const fs = await import('node:fs/promises');
  for (const candidate of UI_HTML_CANDIDATES) {
    try {
      const html = await fs.readFile(candidate);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': html.length,
        'Cache-Control': 'no-store',
      });
      res.end(html);
      return;
    } catch { /* try next */ }
  }
  res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('UI asset not found. Run `npm run build`.');
}

function sseHeaders(res: ServerResponse): void {
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
      emit(job, { type: 'error', message: error instanceof Error ? error.message : String(error) });
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
      if (!entry) throw new Error(`Unknown project id: ${projectId}`);

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
      emit(job, { type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  })();
  return job;
}

export interface RunningServer {
  server: http.Server;
  close: () => Promise<void>;
}

export async function startServer(options: ServeOptions = {}): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8766;
  const dataDir = options.dataDir ?? defaultDataDir();
  await ensureLayout(dataDir);

  const server = http.createServer(async (req, res) => {
    // Lazy job pruning keeps memory bounded without a background timer
    // (the core library contract forbids background watchers/timers).
    pruneJobs();
    try {
      const url = new URL(req.url ?? '/', `http://${host}:${port}`);
      const { pathname } = url;

      if (req.method === 'GET' && pathname === '/favicon.ico') {
        res.writeHead(204); res.end(); return;
      }
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        await serveUi(res); return;
      }
      if (req.method === 'GET' && pathname === '/api/health') {
        respond(res, 200, { status: 'ok', version: WEB_VERSION, dataDir }); return;
      }
      if (req.method === 'GET' && pathname === '/api/config') {
        respond(res, 200, await loadConfig(dataDir)); return;
      }
      if (req.method === 'POST' && pathname === '/api/config') {
        const body = await readJson(req);
        const config = await loadConfig(dataDir);
        if (Array.isArray(body.roots) && body.roots.length) {
          config.roots = body.roots.filter((r): r is string => typeof r === 'string' && r.trim().length > 0);
        }
        if (body.contentMode === 'metadata_only' || body.contentMode === 'summary' || body.contentMode === 'full') {
          config.contentMode = body.contentMode;
        }
        await saveConfig(dataDir, config);
        respond(res, 200, config); return;
      }
      if (req.method === 'GET' && pathname === '/api/catalog') {
        const catalog = await loadCatalog(dataDir);
        respond(res, 200, catalog ?? { version: 1, updatedAt: null, config: await loadConfig(dataDir), repositories: [] });
        return;
      }
      if (req.method === 'POST' && pathname === '/api/scan/repos') {
        const body = await readJson(req);
        const keyword = typeof body.keyword === 'string' ? body.keyword : '';
        const job = await startReposScan(dataDir, keyword);
        respond(res, 200, { job_id: job.id }); return;
      }
      if (req.method === 'POST' && pathname === '/api/scan/project') {
        const body = await readJson(req);
        const projectId = typeof body.projectId === 'string' ? body.projectId : '';
        if (!projectId) { respond(res, 400, { error: 'projectId is required' }); return; }
        const job = await startProjectScan(dataDir, projectId);
        respond(res, 200, { job_id: job.id }); return;
      }

      const jobEvents = pathname.match(/^\/api\/jobs\/([^/]+)\/events$/);
      if (req.method === 'GET' && jobEvents) {
        const job = getJob(jobEvents[1]);
        if (!job) { respond(res, 404, { error: 'job not found' }); return; }
        sseHeaders(res);
        // Replay existing events, then stream live ones.
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
      if (req.method === 'GET' && jobGet) {
        const job = getJob(jobGet[1]);
        if (!job) { respond(res, 404, { error: 'job not found' }); return; }
        respond(res, 200, snapshot(job)); return;
      }

      const detail = pathname.match(/^\/api\/project\/([^/]+)\/detail$/);
      if (req.method === 'GET' && detail) {
        const projectId = detail[1];
        if (!await hasPackage(dataDir, projectId)) {
          respond(res, 404, { error: 'project not scanned yet' }); return;
        }
        const loaded = await loadViewerModel(dataDir, projectId);
        if (!loaded) {
          respond(res, 422, { error: 'package unreadable or empty' }); return;
        }
        const num = (v: string | null, fallback: number) => {
          const n = v == null ? NaN : Number(v);
          return Number.isFinite(n) ? n : fallback;
        };
        const page = buildDetailPage(loaded, {
          q: url.searchParams.get('q') ?? '',
          type: url.searchParams.get('type') ?? '',
          evidence: url.searchParams.get('evidence') ?? '',
          agent: url.searchParams.get('agent') ?? '',
          offset: num(url.searchParams.get('offset'), 0),
          limit: num(url.searchParams.get('limit'), 200),
        });
        respond(res, 200, {
          ...page,
          types: eventTypes(loaded),
          agentOptions: agentOptions(loaded),
        }); return;
      }

      const exportMatch = pathname.match(/^\/api\/project\/([^/]+)\/export$/);
      if (req.method === 'GET' && exportMatch) {
        const projectId = exportMatch[1];
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
        } catch (error) {
          respond(res, 500, { error: 'zip export failed: ' + (error instanceof Error ? error.message : String(error)) });
        }
        return;
      }

      respond(res, 404, { error: 'not found' });
    } catch (error) {
      respond(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  return {
    server,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
