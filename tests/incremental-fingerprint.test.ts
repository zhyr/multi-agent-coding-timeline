import { describe, expect, it } from 'vitest';
import { appendFile, mkdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runScan } from '../src/scan/engine.js';
import { createAdapters } from '../src/adapters/registry.js';
import type { AgentAdapter, AgentSource, SessionReference } from '../src/adapters/types.js';
import type { FileCursor, ScanState } from '../src/scan/state.js';
import { tempDir, createGitRepo, writeCodexSession } from './helpers/fixtures.js';

interface Ctx {
  root: string;
  projectPath: string;
  sourceRoot: string;
  sessionFile: string;
  output: string;
  stateDir: string;
}

async function setup(): Promise<Ctx> {
  const root = await tempDir('aitimeline-fingerprint-');
  const projectPath = path.join(root, 'project');
  const sourceRoot = path.join(root, 'device-data');
  await createGitRepo(projectPath, { remote: 'https://github.com/example/fingerprint-project.git', commits: 1 });
  const sessionFile = path.join(sourceRoot, '.codex/sessions/2026/01/01/rollout-fingerprint.jsonl');
  await mkdir(path.dirname(sessionFile), { recursive: true });
  await writeCodexSession(sessionFile, { cwd: projectPath, sessionId: 'fingerprint-session' });
  return {
    root,
    projectPath,
    sourceRoot,
    sessionFile,
    output: path.join(root, 'out.ai-timeline'),
    stateDir: path.join(root, 'state'),
  };
}

function scan(ctx: Ctx, extra: Record<string, unknown> = {}) {
  return runScan({
    project: ctx.projectPath,
    output: ctx.output,
    sourceRoot: ctx.sourceRoot,
    sourceDevice: 'device-a',
    scannerDevice: 'device-a',
    agents: ['codex'],
    force: true,
    stateDir: ctx.stateDir,
    ...extra,
  });
}

async function readState(ctx: Ctx, projectId: string): Promise<ScanState> {
  const file = path.join(ctx.stateDir, `${projectId}.state.json`);
  return JSON.parse(await readFile(file, 'utf8')) as ScanState;
}

function codexEvents(result: Awaited<ReturnType<typeof scan>>) {
  return result.data.events.filter((e) => e.agent?.agent_id === 'codex');
}

describe('incremental content fingerprint', () => {
  it('detects a same-size rewrite even when mtime is restored', async () => {
    const ctx = await setup();
    const first = await scan(ctx);
    const original = await stat(ctx.sessionFile);

    const before = await readFile(ctx.sessionFile, 'utf8');
    const rewritten = before.replace('Please implement feature A', 'Please implement feature B');
    expect(rewritten).not.toBe(before);
    expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(before));
    await writeFile(ctx.sessionFile, rewritten);
    await utimes(ctx.sessionFile, original.atime, original.mtime);

    const second = await scan(ctx);
    expect(second.report.sources_skipped_unchanged).toBe(0);
    expect(second.report.sources_fingerprint_checked).toBeGreaterThan(0);
    expect(JSON.stringify(codexEvents(second))).toContain('feature B');
    const state = await readState(ctx, second.data.manifest.project_id);
    const cursor = Object.values(state.files)[0] as FileCursor;
    expect(cursor.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(second.report.sources_changed_during_read).toBe(0);
  });

  it('re-verifies when only mtime changes but content is identical', async () => {
    const ctx = await setup();
    const first = await scan(ctx);
    const now = new Date(Date.now() + 5000);
    await utimes(ctx.sessionFile, now, now);

    const second = await scan(ctx);
    expect(second.report.sources_skipped_unchanged).toBe(0);
    expect(codexEvents(second).length).toBe(codexEvents(first).length);
    expect(codexEvents(second).map((e) => e.event_id)).toEqual(codexEvents(first).map((e) => e.event_id));
  });

  it('upgrades a legacy size+mtime cursor exactly once after a full re-parse', async () => {
    const ctx = await setup();
    const first = await scan(ctx);
    const projectId = first.data.manifest.project_id;
    const state = await readState(ctx, projectId);
    for (const cursor of Object.values(state.files)) {
      delete cursor.sha256;
      delete cursor.fingerprint_kind;
      delete cursor.ctime_at;
      delete cursor.inode;
    }
    await writeFile(path.join(ctx.stateDir, `${projectId}.state.json`), JSON.stringify(state));

    const second = await scan(ctx);
    expect(second.report.sources_skipped_unchanged).toBe(0);
    expect(second.report.sources_fingerprint_checked).toBeGreaterThan(0);
    const upgraded = await readState(ctx, projectId);
    expect(Object.values(upgraded.files)[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles an empty session file without recording phantom events', async () => {
    const ctx = await setup();
    await writeFile(ctx.sessionFile, '');
    const first = await scan(ctx);
    const second = await scan(ctx);
    expect(codexEvents(first)).toHaveLength(0);
    expect(codexEvents(second)).toHaveLength(0);
    expect(second.report.sources_failed).toBe(0);
    expect(second.data.sources.every((s) => s.status !== 'skipped_unchanged')).toBe(true);
    const state = await readState(ctx, second.data.manifest.project_id);
    // An empty read is truncated, so it must not create a reusable cursor.
    expect(Object.keys(state.files)).toHaveLength(0);
  });

  it('discards a read when the file changes while it is being parsed', async () => {
    const ctx = await setup();
    const codex = createAdapters().find((a) => a.id === 'codex')!;
    let mutate = true;
    const source: AgentSource = {
      source_id: 'race-source',
      agent_id: 'codex',
      root: ctx.sourceRoot,
      display_path: ctx.sourceRoot,
      format: 'jsonl',
      discovered_from: 'fixture',
      readable: true,
      metadata: { matched_layout: true },
    };
    const adapter: AgentAdapter = {
      id: 'codex',
      name: 'Codex race fixture',
      version: '1.0.0',
      discoverSources: async () => [source],
      scanSessions: async (): Promise<SessionReference[]> => {
        const info = await stat(ctx.sessionFile);
        return [{
          native_session_id: 'race-session',
          source,
          path: ctx.sessionFile,
          relative_path: 'race/session.jsonl',
          size_bytes: info.size,
          modified_at: info.mtime.toISOString(),
          project_evidence: { cwd: ctx.projectPath },
        }];
      },
      parseSession: async () => {
        if (mutate) {
          mutate = false;
          await appendFile(ctx.sessionFile, '{"ordinal":99}\n');
        }
        return {
          records: [{
            event_type: 'agent.user_request.submitted',
            native_event_id: 'race-1',
            role: 'user',
            content: 'race request',
            occurred_at: '2026-11-17T02:00:00.000Z',
            timestamp_precision: 'second',
            evidence_level: 'verified',
            capture_level: 'observed',
            source_record_id: 'race-1',
            sequence: 0,
            project_evidence: { cwd: ctx.projectPath },
          }],
          issues: [],
          truncated: false,
        };
      },
      getCapabilities: () => codex.getCapabilities(),
    };

    const first = await runScan({
      project: ctx.projectPath,
      output: ctx.output,
      sourceRoot: ctx.sourceRoot,
      sourceDevice: 'device-a',
      agents: ['codex'],
      adapters: [adapter],
      force: true,
      stateDir: ctx.stateDir,
    });
    expect(first.report.sources_changed_during_read).toBe(1);
    expect(first.data.sources.some((s) => s.status === 'partial' && /changed while/.test(s.reason ?? ''))).toBe(true);
    expect(codexEvents(first)).toHaveLength(0);
    const afterFirst = await readState(ctx, first.data.manifest.project_id);
    expect(Object.keys(afterFirst.files)).toHaveLength(0);

    const second = await runScan({
      project: ctx.projectPath,
      output: ctx.output,
      sourceRoot: ctx.sourceRoot,
      sourceDevice: 'device-a',
      agents: ['codex'],
      adapters: [adapter],
      force: true,
      stateDir: ctx.stateDir,
    });
    expect(second.report.sources_changed_during_read).toBe(0);
    expect(codexEvents(second)).toHaveLength(1);
    const afterSecond = await readState(ctx, second.data.manifest.project_id);
    expect(Object.values(afterSecond.files)[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('re-parses appended content and updates the content hash', async () => {
    const ctx = await setup();
    const first = await scan(ctx);
    const firstState = await readState(ctx, first.data.manifest.project_id);
    const firstHash = Object.values(firstState.files)[0]?.sha256;
    await appendFile(ctx.sessionFile, JSON.stringify({
      ordinal: 20,
      timestamp: '2026-11-17T01:01:00.000Z',
      type: 'response_item',
      payload: { role: 'user', content: 'follow-up' },
    }) + '\n');
    const second = await scan(ctx);
    expect(second.report.sources_skipped_unchanged).toBe(0);
    expect(codexEvents(second).length).toBe(codexEvents(first).length + 1);
    const state = await readState(ctx, second.data.manifest.project_id);
    expect(Object.values(state.files)[0]?.sha256).not.toBe(firstHash);
  });

  it('removes the cursor and stops emitting a deleted source', async () => {
    const ctx = await setup();
    const first = await scan(ctx);
    expect(codexEvents(first).length).toBeGreaterThan(0);
    await unlink(ctx.sessionFile);

    const second = await scan(ctx);
    expect(codexEvents(second)).toHaveLength(0);
    expect(second.report.sources_scanned).toBe(0);
    const state = await readState(ctx, second.data.manifest.project_id);
    expect(Object.keys(state.files)).toHaveLength(0);
  });

  it('treats a renamed source as a new file instead of inheriting the old cursor', async () => {
    const ctx = await setup();
    const first = await scan(ctx);
    const renamed = path.join(path.dirname(ctx.sessionFile), 'rollout-renamed.jsonl');
    await rename(ctx.sessionFile, renamed);

    const second = await scan(ctx);
    expect(second.report.sources_skipped_unchanged).toBe(0);
    expect(codexEvents(second).length).toBe(codexEvents(first).length);
    const state = await readState(ctx, second.data.manifest.project_id);
    const keys = Object.keys(state.files);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain('rollout-renamed.jsonl');
    expect(keys[0]).not.toContain('rollout-fingerprint.jsonl');
  });

  it('keeps cursors isolated per source device when scans share a state directory', async () => {
    const ctx = await setup();
    const sourceB = path.join(ctx.root, 'device-b-data');
    const fileB = path.join(sourceB, '.codex/sessions/2026/01/01/rollout-fingerprint.jsonl');
    await mkdir(path.dirname(fileB), { recursive: true });
    await writeCodexSession(fileB, { cwd: ctx.projectPath, sessionId: 'device-b-session' });

    const outA = path.join(ctx.root, 'out-a.ai-timeline');
    const outB = path.join(ctx.root, 'out-b.ai-timeline');
    const common = {
      project: ctx.projectPath,
      agents: ['codex'],
      force: true,
      stateDir: ctx.stateDir,
    };
    const a = await runScan({ ...common, output: outA, sourceRoot: ctx.sourceRoot, sourceDevice: 'device-a', scannerDevice: 'device-a' });
    const b = await runScan({ ...common, output: outB, sourceRoot: sourceB, sourceDevice: 'device-b', scannerDevice: 'device-b' });
    const state = await readState(ctx, a.data.manifest.project_id);
    const keys = Object.keys(state.files);
    expect(keys.some((k) => k.startsWith('device-a:'))).toBe(true);
    expect(keys.some((k) => k.startsWith('device-b:'))).toBe(true);

    const aAgain = await runScan({ ...common, output: outA, sourceRoot: ctx.sourceRoot, sourceDevice: 'device-a', scannerDevice: 'device-a' });
    expect(aAgain.report.sources_skipped_unchanged).toBe(1);
    const after = await readState(ctx, a.data.manifest.project_id);
    expect(Object.keys(after.files).sort()).toEqual(keys.sort());
    expect(b.data.events.length).toBeGreaterThan(0);
  });

  it('does not reuse a session whose modified_at is unavailable', async () => {
    const ctx = await setup();
    const codex = createAdapters().find((a) => a.id === 'codex')!;
    const source: AgentSource = {
      source_id: 'no-mtime',
      agent_id: 'codex',
      root: ctx.sourceRoot,
      display_path: ctx.sourceRoot,
      format: 'jsonl',
      discovered_from: 'fixture',
      readable: true,
      metadata: { matched_layout: true },
    };
    const adapter: AgentAdapter = {
      id: 'codex',
      name: 'Codex no-mtime fixture',
      version: '1.0.0',
      discoverSources: async () => [source],
      scanSessions: async (): Promise<SessionReference[]> => [{
        native_session_id: 'no-mtime-session',
        source,
        path: ctx.sessionFile,
        relative_path: 'no-mtime/session.jsonl',
        size_bytes: (await stat(ctx.sessionFile)).size,
        project_evidence: { cwd: ctx.projectPath },
      }],
      parseSession: (s) => codex.parseSession(s),
      getCapabilities: () => codex.getCapabilities(),
    };
    const opts = {
      project: ctx.projectPath,
      output: ctx.output,
      sourceRoot: ctx.sourceRoot,
      sourceDevice: 'device-a',
      agents: ['codex'],
      adapters: [adapter],
      force: true,
      stateDir: ctx.stateDir,
    };
    const first = await runScan(opts);
    const second = await runScan(opts);
    expect(first.report.sources_skipped_unchanged).toBe(0);
    expect(second.report.sources_skipped_unchanged).toBe(0);
    expect(second.report.sources_fingerprint_checked).toBe(0);
    expect(codexEvents(second).length).toBe(codexEvents(first).length);
    const state = await readState(ctx, second.data.manifest.project_id);
    expect(Object.keys(state.files)).toHaveLength(0);
  });
});
