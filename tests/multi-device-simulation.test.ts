import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runScan } from '../src/scan/engine.js';
import { runMerge } from '../src/merge/engine.js';
import { validatePackage } from '../src/package/index.js';
import { tempDir, createGitRepo, writeCodexSession, writeJsonl } from './helpers/fixtures.js';

const REMOTE = 'https://github.com/example/contextbuilder.git';
const SESSION_UUID = '7d6b0f2e-6a41-4c3a-9d0e-2b1c7a9f0001';

/** Claude Code transcript with uuid/parentUuid so both devices produce the same native ids. */
async function writeClaudeTranscript(
  home: string,
  projectPath: string,
  sessionId: string,
  turns: Array<{ uuid: string; role: 'user' | 'assistant'; text: string; at: string }>,
): Promise<string> {
  const relative = `projects/Users-alice-work-contextbuilder/${sessionId}.jsonl`;
  const file = path.join(home, '.claude', relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeJsonl(
    file,
    turns.map((turn) => ({
      type: turn.role,
      uuid: turn.uuid,
      parentUuid: turn.role === 'assistant' ? turns[turns.findIndex((t) => t.uuid === turn.uuid) - 1]?.uuid : undefined,
      sessionId,
      cwd: projectPath,
      timestamp: turn.at,
      message: { role: turn.role, content: turn.role === 'assistant' ? [{ type: 'text', text: turn.text }] : turn.text },
    })),
  );
  return file;
}

/** Minimal Al-exporter 1.1.0 archive inside a simulated device home. */
async function writeImportArchive(home: string, projectPath: string, corrupt = false): Promise<void> {
  const archive = path.join(home, 'agent-backup');
  await mkdir(path.join(archive, 'workbuddy'), { recursive: true });
  const declaredDevice = {
    source_device_id: 'dev_archive_alpha',
    source_device_id_basis: 'export_host',
    source_hostname: 'archive-host',
  };
  const manifest = {
    exporter_version: '2.3.0',
    schema_version: '1.1.0',
    exported_at: '2026-11-18T00:00:00.000Z',
    sources_seen: ['workbuddy'],
    device: declaredDevice,
    items: [
      {
        file: 'workbuddy/thread-0.json',
        source: 'workbuddy',
        thread_id: 'thread-sim-0',
        hash: 'hash-0',
        sha256: '0'.repeat(64),
      },
    ],
  };
  const thread = {
    schema_version: '1.1.0',
    thread_id: 'thread-sim-0',
    type: 'thread',
    title: 'imported workbuddy session',
    messages: [
      {
        role: 'user',
        content: 'imported request about contextbuilder',
        timestamp: '2026-11-18T01:00:00.000Z',
        id: 'wb-evt-1',
        line: 1,
      },
      {
        role: 'assistant',
        content: 'imported response about contextbuilder',
        timestamp: '2026-11-18T01:00:05.000Z',
        id: 'wb-evt-2',
        line: 2,
      },
    ],
    meta: {
      source: 'workbuddy',
      created_at: '2000-01-01T00:00:00.000Z',
      file_path: '/Users/alice/.workbuddy/projects/contextbuilder/wb-sim-1.jsonl',
      extra: {},
    },
    session: {
      native_id: 'wb-sim-1',
      native_id_kind: 'uuid',
      native_id_source: 'file.basename',
      cwd: projectPath,
      cwd_source: 'workbuddy.record',
      git_remote: REMOTE,
      git_remote_source: 'cwd_git_config',
    },
    device: declaredDevice,
  };
  await writeFile(path.join(archive, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await writeFile(
    path.join(archive, 'workbuddy/thread-0.json'),
    corrupt ? '{ this is not valid json' : JSON.stringify(thread, null, 2),
    'utf8',
  );
}

/**
 * Simulated Multi-Device Integration Test.
 *
 * Two devices are simulated with separate source roots:
 * - device-alpha: Codex + Claude Code records for the contextbuilder project.
 * - device-beta:  a second copy of the same Claude session (same native ids) plus a
 *   Claude-only turn and an Al-exporter import archive.
 * No real device is claimed; every path lives in a temporary directory.
 */
describe('Simulated Multi-Device Integration Test', () => {
  it('merges Device A (Codex + Claude Code) with Device B (remote scan + import) without losing records', async () => {
    const root = await tempDir('aitimeline-sim-devices-');
    const projectPath = path.join(root, 'contextbuilder');
    await createGitRepo(projectPath, { remote: REMOTE, commits: 2 });
    const homeA = path.join(root, 'home-alpha');
    const homeB = path.join(root, 'home-beta');

    await writeCodexSession(
      path.join(homeA, '.codex/sessions/2026/11/18/rollout-alpha.jsonl'),
      { cwd: projectPath, sessionId: 'codex-sim-alpha' },
    );
    const sharedTurns = [
      { uuid: 'cc-u1', role: 'user' as const, text: 'Plan the contextbuilder scan', at: '2026-11-18T02:00:00.000Z' },
      { uuid: 'cc-u2', role: 'assistant' as const, text: 'Scan plan ready', at: '2026-11-18T02:00:03.000Z' },
    ];
    await writeClaudeTranscript(homeA, projectPath, SESSION_UUID, sharedTurns);
    // Device B observes the same Claude session (copied/synced), plus its own turn.
    await writeClaudeTranscript(homeB, projectPath, SESSION_UUID, sharedTurns);
    await writeClaudeTranscript(homeB, projectPath, 'b1f4c0aa-1111-4222-8333-944455556666', [
      { uuid: 'cc-b1', role: 'user' as const, text: 'Device B remote follow-up', at: '2026-11-18T03:00:00.000Z' },
      { uuid: 'cc-b2', role: 'assistant' as const, text: 'Remote follow-up done', at: '2026-11-18T03:00:04.000Z' },
    ]);
    await writeImportArchive(homeB, projectPath);

    const outA = path.join(root, 'device-alpha.ai-timeline');
    const outB = path.join(root, 'device-beta.ai-timeline');
    const scanA = await runScan({
      project: projectPath,
      output: outA,
      sourceRoot: homeA,
      sourceDevice: 'device-alpha',
      scannerDevice: 'device-alpha',
      agents: ['codex', 'claude-code'],
    });
    const scanB = await runScan({
      project: projectPath,
      output: outB,
      sourceRoot: homeB,
      sourceDevice: 'device-beta',
      scannerDevice: 'device-beta',
      agents: ['claude-code', 'al-exporter'],
    });
    expect(scanA.data.manifest.source_devices).toEqual(['device-alpha']);
    expect(scanB.data.manifest.source_devices).toEqual(['device-beta']);
    expect(scanB.data.events.every((e) => e.device_id === 'device-beta' && e.scanner_device_id === 'device-beta')).toBe(true);
    const imported = scanB.data.events.filter((e) => e.agent?.agent_id === 'workbuddy');
    expect(imported.length).toBeGreaterThanOrEqual(2);
    expect(imported.every((e) => e.evidence.level === 'agent_reported')).toBe(true);
    expect(imported.every((e) => e.provenance.source_path.includes('agent-backup'))).toBe(true);

    const merged = await runMerge({
      inputs: [outA, outB],
      output: path.join(root, 'unified.ai-timeline'),
    });
    expect((await validatePackage(path.join(root, 'unified.ai-timeline'))).ok).toBe(true);
    expect(merged.data.manifest.source_devices).toEqual(['device-alpha', 'device-beta']);
    expect(merged.report.source_devices).toBe(2);
    expect(merged.report.cross_device_deterministic).toBeGreaterThan(0);
    expect(merged.report.cross_device_merged).toBeGreaterThan(0);

    // The shared Claude turn exists once, observed by both devices, with original ids kept.
    const shared = merged.data.events.find(
      (e) => e.agent?.agent_id === 'claude-code' && e.agent.native_event_id === 'cc-u1',
    );
    expect(shared).toBeDefined();
    expect(['device-alpha', 'device-beta']).toContain(shared!.device_id);
    expect(shared!.scanner_device_id).toBe(shared!.device_id);
    expect(shared!.correlation_id).toBeTruthy();
    expect(shared!.provenance.observers?.map((o) => o.device_id).sort()).toEqual(['device-alpha', 'device-beta']);
    expect(merged.data.events.filter((e) => e.agent?.native_event_id === 'cc-u1')).toHaveLength(1);

    // Device B-only activity and the import survive.
    expect(merged.data.events.some((e) => e.agent?.native_event_id === 'cc-b1' && e.device_id === 'device-beta')).toBe(true);
    const importedAfter = merged.data.events.filter((e) => e.agent?.agent_id === 'workbuddy');
    expect(importedAfter.length).toBe(imported.length);
    expect(new Set(merged.data.events.map((e) => e.event_id)).size).toBe(merged.data.events.length);

    // Git commits from the same repository are folded rather than duplicated.
    const commits = merged.data.commits;
    expect(commits.length).toBeGreaterThan(0);
    expect(new Set(commits.map((c) => `${c.commit_sha}:${c.project_id}`)).size).toBe(commits.length);
  });

  it('labels a corrupt import thread as an error without aborting the scan or merge', async () => {
    const root = await tempDir('aitimeline-sim-corrupt-');
    const projectPath = path.join(root, 'contextbuilder');
    await createGitRepo(projectPath, { remote: REMOTE, commits: 1 });
    const home = path.join(root, 'home-beta');
    await writeImportArchive(home, projectPath, true);
    const homeA = path.join(root, 'home-alpha');
    await writeCodexSession(path.join(homeA, '.codex/sessions/2026/11/18/rollout-a.jsonl'), {
      cwd: projectPath,
      sessionId: 'codex-sim-valid',
    });
    const outA = path.join(root, 'device-alpha.ai-timeline');
    await runScan({
      project: projectPath, output: outA, sourceRoot: homeA,
      sourceDevice: 'device-alpha', scannerDevice: 'device-alpha', agents: ['codex'],
    });

    const out = path.join(root, 'device-beta.ai-timeline');
    const scan = await runScan({
      project: projectPath,
      output: out,
      sourceRoot: home,
      sourceDevice: 'device-beta',
      scannerDevice: 'device-beta',
      agents: ['al-exporter'],
    });
    const importSource = scan.data.sources.find((s) => s.agent_id === 'al-exporter');
    expect(importSource).toBeDefined();
    expect(['partial', 'failed']).toContain(importSource!.status);
    expect(scan.data.events.filter((e) => e.agent?.agent_id === 'workbuddy')).toHaveLength(0);
    expect((await validatePackage(out)).ok).toBe(true);

    const merged = await runMerge({ inputs: [out, outA], output: path.join(root, 'unified.ai-timeline') });
    expect((await validatePackage(path.join(root, 'unified.ai-timeline'))).ok).toBe(true);
    expect(merged.data.events.filter((e) => e.agent?.agent_id === 'workbuddy')).toHaveLength(0);
    expect(merged.data.events.some((e) => e.agent?.agent_id === 'codex')).toBe(true);
  });

  it('rejects a merge whose two simulated devices disagree on project identity', async () => {
    const root = await tempDir('aitimeline-sim-diffproj-');
    const projectPath = path.join(root, 'contextbuilder');
    await createGitRepo(projectPath, { remote: REMOTE, commits: 1 });
    const homeA = path.join(root, 'home-alpha');
    const homeB = path.join(root, 'home-beta');
    await writeCodexSession(path.join(homeA, '.codex/sessions/2026/11/18/rollout-a.jsonl'), {
      cwd: projectPath,
      sessionId: 'codex-a',
    });
    await writeCodexSession(path.join(homeB, '.codex/sessions/2026/11/18/rollout-b.jsonl'), {
      cwd: path.join(root, 'other-project'),
      sessionId: 'codex-b',
    });
    const outA = path.join(root, 'a.ai-timeline');
    const outB = path.join(root, 'b.ai-timeline');
    await runScan({
      project: projectPath, output: outA, sourceRoot: homeA,
      sourceDevice: 'device-alpha', scannerDevice: 'device-alpha', agents: ['codex'],
    });
    await runScan({
      project: projectPath, output: outB, sourceRoot: homeB,
      sourceDevice: 'device-beta', scannerDevice: 'device-beta', agents: ['codex'],
      explicitProjectId: 'proj_other_identity', explicitRemoteUrl: 'https://github.com/example/other.git',
    });
    await expect(
      runMerge({ inputs: [outA, outB], output: path.join(root, 'unified.ai-timeline') }),
    ).rejects.toThrow(/different project identities|different project/i);
  });
});
