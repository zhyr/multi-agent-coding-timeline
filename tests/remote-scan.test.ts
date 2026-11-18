import { describe, it, expect, beforeEach } from 'vitest';
import { mkdir, writeFile, readFile, chmod, symlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runScan } from '../src/scan/engine.js';
import { validatePackage, readPackage } from '../src/package/index.js';
import { tempDir, createGitRepo, writeCodexSession } from './helpers/fixtures.js';

interface Setup {
  root: string;
  projectPath: string;
  sourceRoot: string;
  sessionFile: string;
}

async function setup(): Promise<Setup> {
  const root = await tempDir('aitimeline-remote-');
  const projectPath = path.join(root, 'project');
  const sourceRoot = path.join(root, 'device-a-data');
  await createGitRepo(projectPath, { remote: 'https://github.com/example/fixture-project.git', commits: 2 });
  const sessionFile = path.join(sourceRoot, '.codex/sessions/2026/01/01/rollout-device-a.jsonl');
  await mkdir(path.dirname(sessionFile), { recursive: true });
  await writeCodexSession(sessionFile, { cwd: projectPath, sessionId: 'device-a-session-1' });
  return { root, projectPath, sourceRoot, sessionFile };
}

function digest(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('Mode B: Remote Source Scan', () => {
  let ctx: Setup;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('attributes the timeline to the source device while recording the scanner separately', async () => {
    const output = path.join(ctx.root, 'out.ai-timeline');
    const result = await runScan({
      project: ctx.projectPath,
      output,
      sourceRoot: ctx.sourceRoot,
      sourceDevice: 'device-a',
      scannerDevice: 'device-b',
      agents: ['codex'],
    });
    expect(result.sourceDeviceId).toBe('device-a');
    expect(result.scannerDeviceId).toBe('device-b');
    expect(result.data.manifest.source_devices).toEqual(['device-a']);
    expect(result.data.scanInputs?.explicit_source_device).toBe(true);
    expect(result.data.scanInputs?.read_only).toBe(true);
    const source = result.data.devices.find((d) => d.device_id === 'device-a')!;
    const scanner = result.data.devices.find((d) => d.device_id === 'device-b')!;
    expect(source.role).toBe('source');
    expect(scanner.role).toBe('scanner');
    // The scanner hostname must never leak onto the source device record.
    expect(source.hostname).toBeUndefined();
    expect(scanner.hostname).toBeTruthy();
    const agentEvents = result.data.events.filter((e) => e.agent?.agent_id === 'codex');
    expect(agentEvents.length).toBeGreaterThan(0);
    expect(agentEvents.every((e) => e.device_id === 'device-a' && e.scanner_device_id === 'device-b')).toBe(true);
    expect(agentEvents.every((e) => e.provenance.source_path_identity.startsWith('codex/'))).toBe(true);
    expect((await validatePackage(output)).ok).toBe(true);
  });

  it('never writes to source agent records or source Git state', async () => {
    const beforeSession = digest(await readFile(ctx.sessionFile));
    const beforeHead = digest(await readFile(path.join(ctx.projectPath, '.git/HEAD')));
    const beforeConfig = digest(await readFile(path.join(ctx.projectPath, '.git/config')));
    await runScan({
      project: ctx.projectPath,
      output: path.join(ctx.root, 'out.ai-timeline'),
      sourceRoot: ctx.sourceRoot,
      sourceDevice: 'device-a',
      scannerDevice: 'device-b',
      agents: ['codex'],
      contentMode: 'full',
    });
    expect(digest(await readFile(ctx.sessionFile))).toBe(beforeSession);
    expect(digest(await readFile(path.join(ctx.projectPath, '.git/HEAD')))).toBe(beforeHead);
    expect(digest(await readFile(path.join(ctx.projectPath, '.git/config')))).toBe(beforeConfig);
  });

  it('rejects a remote scan without an explicit source device id', async () => {
    await expect(
      runScan({
        project: ctx.projectPath,
        output: path.join(ctx.root, 'out.ai-timeline'),
        sourceRoot: ctx.sourceRoot,
        agents: ['codex'],
      }),
    ).rejects.toThrow(/requires --source-device/);
  });

  it('reports a missing source directory clearly', async () => {
    await expect(
      runScan({
        project: ctx.projectPath,
        output: path.join(ctx.root, 'out.ai-timeline'),
        sourceRoot: path.join(ctx.root, 'does-not-exist'),
        sourceDevice: 'device-a',
        agents: ['codex'],
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it('reports an inaccessible source directory clearly', async () => {
    const blocked = path.join(ctx.root, 'blocked');
    await mkdir(blocked, { recursive: true });
    await chmod(blocked, 0o000);
    try {
      await expect(
        runScan({
          project: ctx.projectPath,
          output: path.join(ctx.root, 'out.ai-timeline'),
          sourceRoot: blocked,
          sourceDevice: 'device-a',
          agents: ['codex'],
        }),
      ).rejects.toThrow(/not readable|permission denied|does not exist/);
    } finally {
      await chmod(blocked, 0o755);
    }
  });

  it('isolates malformed records and reports a partial scan', async () => {
    await writeFile(ctx.sessionFile, (await readFile(ctx.sessionFile, 'utf8')) + '{broken line\n');
    const output = path.join(ctx.root, 'out.ai-timeline');
    const result = await runScan({
      project: ctx.projectPath,
      output,
      sourceRoot: ctx.sourceRoot,
      sourceDevice: 'device-a',
      scannerDevice: 'device-b',
      agents: ['codex'],
    });
    expect(result.report.malformed_records).toBeGreaterThan(0);
    expect(result.report.warnings.some((w) => w.includes('malformed'))).toBe(true);
    expect(result.data.sources.some((s) => s.malformed_records! > 0)).toBe(true);
    expect((await validatePackage(output)).ok).toBe(true);
  });

  it('skips symlinks instead of following them out of the source root', async () => {
    const outside = path.join(ctx.root, 'outside.jsonl');
    await writeCodexSession(outside, { cwd: ctx.projectPath, sessionId: 'outside-session' });
    await symlink(outside, path.join(ctx.sourceRoot, '.codex/sessions/2026/01/01/link.jsonl'));
    const result = await runScan({
      project: ctx.projectPath,
      output: path.join(ctx.root, 'out.ai-timeline'),
      sourceRoot: ctx.sourceRoot,
      sourceDevice: 'device-a',
      scannerDevice: 'device-b',
      agents: ['codex'],
    });
    expect(result.report.symlinks_skipped).toBeGreaterThan(0);
    expect(result.data.sources.some((s) => s.source_path_identity.includes('link.jsonl'))).toBe(false);
  });

  it('excludes candidate-grade sessions by default and lists them in the report', async () => {
    const extra = path.join(ctx.sourceRoot, '.codex/sessions/2026/01/01/rollout-unrelated.jsonl');
    await writeCodexSession(extra, { cwd: '/completely/unrelated/project', sessionId: 'unrelated-session' });
    const base = {
      project: ctx.projectPath,
      sourceRoot: ctx.sourceRoot,
      sourceDevice: 'device-a',
      scannerDevice: 'device-b',
      agents: ['codex'],
    };
    const strict = await runScan({ ...base, output: path.join(ctx.root, 'strict'), });
    expect(strict.report.sessions_candidate_only).toBeGreaterThan(0);
    expect(strict.report.candidates?.some((c) => c.native_session_id.includes('unrelated'))).toBe(true);
    expect(strict.data.events.some((e) => e.provenance.source_record_id?.includes('unrelated'))).toBe(false);
    const permissive = await runScan({ ...base, output: path.join(ctx.root, 'permissive'), includeCandidates: true });
    // Explicitly included candidates are counted separately, never as matches.
    expect(permissive.report.sessions_matched).toBe(strict.report.sessions_matched);
    expect(permissive.report.sessions_candidates_included).toBeGreaterThan(0);
    expect(permissive.data.events.some((e) => e.correlation?.note?.includes('candidate'))).toBe(true);
  });

  it('supports incremental manual scans without re-parsing unchanged files', async () => {
    const output = path.join(ctx.root, 'out.ai-timeline');
    const first = await runScan({
      project: ctx.projectPath, output, sourceRoot: ctx.sourceRoot,
      sourceDevice: 'device-a', scannerDevice: 'device-b', agents: ['codex'], force: true,
    });
    const second = await runScan({
      project: ctx.projectPath, output, sourceRoot: ctx.sourceRoot,
      sourceDevice: 'device-a', scannerDevice: 'device-b', agents: ['codex'], force: true,
    });
    expect(second.report.sources_skipped_unchanged).toBeGreaterThan(0);
    expect(second.data.events.length).toBe(first.data.events.length);
    expect(second.data.events.map((e) => e.event_id).sort()).toEqual(first.data.events.map((e) => e.event_id).sort());
    expect((await readPackage(output)).data.events).toHaveLength(first.data.events.length);
  });

  it('re-parses changed files and keeps the package deduplicated', async () => {
    const output = path.join(ctx.root, 'out.ai-timeline');
    const first = await runScan({
      project: ctx.projectPath, output, sourceRoot: ctx.sourceRoot,
      sourceDevice: 'device-a', scannerDevice: 'device-b', agents: ['codex'],
    });
    await writeFile(ctx.sessionFile, (await readFile(ctx.sessionFile, 'utf8')) + JSON.stringify({
      ordinal: 20, timestamp: '2026-11-17T01:01:00.000Z', type: 'response_item',
      payload: { role: 'user', content: 'a new follow-up request' },
    }) + '\n');
    const second = await runScan({
      project: ctx.projectPath, output, sourceRoot: ctx.sourceRoot,
      sourceDevice: 'device-a', scannerDevice: 'device-b', agents: ['codex'], force: true,
    });
    expect(second.data.events.length).toBe(first.data.events.length + 1);
    expect(new Set(second.data.events.map((e) => e.event_id)).size).toBe(second.data.events.length);
  });
});
