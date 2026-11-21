import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, stat, chmod } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import type { AgentAdapter, AgentSource } from '../../src/adapters/types.js';
import type { TimelineData } from '../../src/package/model.js';
import type { ActivityEvent, Manifest } from '../../src/schema/entities.js';
import { computeContentHash, computeEventId } from '../../src/core/ids.js';

const exec = promisify(execFile);

export async function tempDir(prefix = 'aitimeline-test-'): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function createGitRepo(
  dir: string,
  options: { remote?: string; commits?: number; withRemoteTrackingRef?: boolean } = {},
): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  await exec('git', ['init', '-q', '-b', 'main', dir]);
  if (options.remote) await exec('git', ['-C', dir, 'remote', 'add', 'origin', options.remote]);
  const shas: string[] = [];
  const count = options.commits ?? 2;
  for (let i = 0; i < count; i += 1) {
    await writeFile(path.join(dir, `file-${i}.txt`), `synthetic fixture content ${i}\n`);
    await exec('git', ['-C', dir, 'add', `file-${i}.txt`]);
    await exec('git', [
      '-C', dir, '-c', 'user.name=Fixture Author', '-c', 'user.email=fixture@example.com',
      'commit', '-q', '-m', `synthetic commit ${i}`,
    ]);
    const { stdout } = await exec('git', ['-C', dir, 'rev-parse', 'HEAD']);
    shas.push(stdout.trim());
  }
  if (options.withRemoteTrackingRef) {
    // A local remote-tracking ref is enough to exercise `inferred` push evidence.
    await exec('git', ['-C', dir, 'update-ref', 'refs/remotes/origin/main', shas[shas.length - 1]!]);
  }
  return shas;
}

export async function writeJsonl(target: string, records: unknown[]): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/** Codex rollout JSONL with a session_meta carrying a cwd for project matching. */
export async function writeCodexSession(
  target: string,
  options: { cwd: string; sessionId: string; includeMalformed?: boolean; includeToolCall?: boolean } = {
    cwd: '/tmp/fixture-project',
    sessionId: 'fixture-codex-1',
  },
): Promise<void> {
  const records: unknown[] = [
    {
      ordinal: 0,
      timestamp: '2026-11-17T01:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: options.sessionId,
        session_id: options.sessionId,
        cwd: options.cwd,
        cli_version: 'fixture-1.0.0',
        model_provider: 'fixture',
      },
    },
    {
      ordinal: 1,
      timestamp: '2026-11-17T01:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'Please implement feature A' }] },
    },
    {
      ordinal: 2,
      timestamp: '2026-11-17T01:00:05.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Implemented feature A' }] },
    },
    {
      ordinal: 3,
      timestamp: '2026-11-17T01:00:06.000Z',
      type: 'event_msg',
      payload: { type: 'task_complete', message: 'done', turn_id: 'turn-1' },
    },
  ];
  if (options.includeToolCall) {
    records.splice(3, 0, {
      ordinal: 10,
      timestamp: '2026-11-17T01:00:03.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'function_call', name: 'shell', id: 'call-1', input: { cmd: 'echo ok' } }] },
    });
  }
  let content = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  if (options.includeMalformed) content += '{"ordinal":99,"type":"response_item","payload":\n';
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

export async function writeQoderSession(target: string, cwd: string, sessionId = 'fixture-qoder-1'): Promise<void> {
  const records = [
    { type: 'workspace-directories', sessionId, directories: [cwd] },
    { type: 'runtime-config', sessionId, model: 'fixture-model', timestamp: '2026-11-17T02:00:00.000Z' },
    {
      type: 'user', sessionId, uuid: 'q-uuid-1', cwd, gitBranch: 'main',
      timestamp: '2026-11-17T02:00:01.000Z',
      message: { role: 'user', content: 'Add a timeline exporter' },
    },
    {
      type: 'assistant', sessionId, uuid: 'q-uuid-2', cwd, parentUuid: 'q-uuid-1',
      timestamp: '2026-11-17T02:00:09.000Z',
      message: { role: 'assistant', model: 'fixture-model', content: [{ type: 'text', text: 'Exporter added' }] },
    },
  ];
  await writeJsonl(target, records);
}

export async function writeCursorTranscript(target: string): Promise<void> {
  await writeJsonl(target, [
    { role: 'user', message: { content: [{ type: 'text', text: 'Fix the parser @src/index.ts' }] } },
    {
      role: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Parser fixed' },
          { type: 'text', text: 'All tests pass' },
          { type: 'tool_use', name: 'Read', input: { path: '/tmp/fixture-project/src/index.ts' } },
          { type: 'tool_use', name: 'Grep', input: { pattern: 'parser' } },
        ],
      },
    },
    { type: 'turn_ended', status: 'success' },
  ]);
}

export async function writeWorkBuddyAudit(target: string): Promise<void> {
  await writeJsonl(target, [
    {
      id: 'audit-1', timestamp: '2026-11-17T03:00:00.000Z', sequence: 1,
      eventType: 'network.approved', category: 'network', decision: 'approved',
      sessionId: 'fixture-wb-session', requestId: 'req-1', toolCallId: 'tool-1',
      messageKey: 'network.ask-matched', messageParams: { paths: ['/tmp/fixture-project/src/index.ts'] },
    },
  ]);
}

/** Observed WorkBuddy conversation transcript shape (projects/<cwd>/<uuid>.jsonl). */
export async function writeWorkBuddyTranscript(target: string): Promise<void> {
  const sessionId = '74d80a47-d27c-4006-857f-e9c044edd5a9';
  const cwd = '/tmp/fixture-project';
  const at = (offset: number) => 1794778991000 + offset;
  await writeJsonl(target, [
    { type: 'session-meta', id: 'wb-e1', sessionId, timestamp: at(0) },
    {
      type: 'ai-title', id: 'wb-e2', sessionId, timestamp: at(1),
      aiTitle: 'Fixture WorkBuddy session', cwd,
    },
    {
      type: 'message', id: 'wb-e3', sessionId, timestamp: at(2),
      role: 'user', cwd,
      content: [{ type: 'input_text', text: 'Please update the ledger' }],
    },
    {
      type: 'reasoning', id: 'wb-e4', sessionId, timestamp: at(3),
      cwd, content: [],
      rawContent: [{ type: 'reasoning_text', text: 'First resolve the workbook.' }],
    },
    {
      type: 'message', id: 'wb-e5', sessionId, timestamp: at(4),
      role: 'assistant', cwd,
      providerData: { model: 'fixture-model' },
      content: [{ type: 'output_text', text: 'Ledger updated.' }],
    },
    {
      type: 'function_call', id: 'wb-e6', sessionId, timestamp: at(5),
      cwd, name: 'read_table', callId: 'call-1',
      arguments: { sheet_id: '000001' },
    },
    {
      type: 'function_call_result', id: 'wb-e7', sessionId, timestamp: at(6),
      cwd, name: 'read_table', callId: 'call-1', status: 'completed',
      output: { type: 'text', text: 'ok' },
    },
    {
      type: 'file-history-snapshot', timestamp: at(7), cwd,
      messageId: 'wb-e5', snapshot: { trackedFileBackups: { 'src/a.ts': {} } },
    },
    { type: 'credit-usage', id: 'wb-e8', sessionId, timestamp: at(8), cwd },
  ]);
}

export async function writeTraeMemory(target: string): Promise<void> {
  await writeJsonl(target, [
    {
      message_id: 'tr-1', intent: 'Refactor scanner', outcome: 'reported complete',
      actions: ['read', 'write'], learned: ['keep provenance'],
      message_summary_time: '2026-11-17T04:00:00.000Z',
    },
  ]);
}

/**
 * Synthetic Antigravity brain directory: one conversation with task, plan and
 * walkthrough artifacts plus a resolved revision, and a second conversation
 * with only a task artifact.
 */
export async function writeAntigravityBrain(root: string): Promise<string> {
  const first = path.join(root, 'brain/11111111-1111-4111-8111-111111111111');
  await mkdir(first, { recursive: true });
  await writeFile(path.join(first, 'task.md'), '# Task\n\n- [x] Read the source\n- [ ] Write the report\n');
  await writeFile(
    path.join(first, 'task.md.metadata.json'),
    JSON.stringify({
      artifactType: 'ARTIFACT_TYPE_TASK',
      summary: 'Checklist for the fixture task.',
      updatedAt: '2026-03-25T11:34:09.042989Z',
    }),
  );
  await writeFile(path.join(first, 'task.md.resolved'), '# Task\n\n- [x] Read the source\n');
  await writeFile(
    path.join(first, 'implementation_plan.md'),
    '# Plan\n\n1. Inspect the repository.\n2. Apply the change.\n',
  );
  await writeFile(
    path.join(first, 'implementation_plan.md.metadata.json'),
    JSON.stringify({
      artifactType: 'ARTIFACT_TYPE_IMPLEMENTATION_PLAN',
      summary: 'Plan for the fixture task.',
      updatedAt: '2026-03-25T11:34:25.433272Z',
    }),
  );
  await writeFile(
    path.join(first, 'walkthrough.md'),
    '# Walkthrough\n\nThe change is complete and tests pass.\n',
  );
  await writeFile(
    path.join(first, 'walkthrough.md.metadata.json'),
    JSON.stringify({
      artifactType: 'ARTIFACT_TYPE_WALKTHROUGH',
      summary: 'Completion walkthrough.',
      updatedAt: '2026-03-25T11:35:00.000000Z',
    }),
  );
  await writeFile(
    path.join(first, 'walkthrough.md.resolved'),
    '# Walkthrough\n\nThe change is in progress.\n',
  );
  const second = path.join(root, 'brain/22222222-2222-4222-8222-222222222222');
  await mkdir(second, { recursive: true });
  await writeFile(path.join(second, 'task.md'), '# Task\n\n- [ ] Only a task artifact\n');
  return first;
}

/** Wrap a real adapter so discovery points at a synthetic fixture root (no home directory access). */
export function fixtureAdapter(adapter: AgentAdapter, root: string): AgentAdapter {
  const source: AgentSource = {
    source_id: `${adapter.id}-fixture`,
    agent_id: adapter.id,
    root,
    display_path: root,
    format: 'jsonl',
    discovered_from: 'fixture',
    readable: true,
    metadata: { matched_layout: true },
  };
  return {
    id: adapter.id,
    name: adapter.name,
    version: adapter.version,
    discoverSources: async () => [source],
    scanSessions: (s) => adapter.scanSessions(s),
    parseSession: (s) => adapter.parseSession(s),
    getCapabilities: () => adapter.getCapabilities(),
  };
}

/** Minimal but schema-valid TimelineData for package-level tests. */
export function makeTimelineData(overrides: Partial<TimelineData> = {}): TimelineData {
  const manifest: Manifest = {
    format: 'ai-coding-timeline',
    format_version: '1.0.0',
    schema_version: '1.0.0',
    timeline_id: 'tln_fixture',
    project_id: 'proj_fixture',
    project_name: 'fixture-project',
    created_at: '2026-11-17T00:00:00.000Z',
    operation: 'scan',
    source_devices: ['device-fixture'],
    event_count: 0,
    session_count: 0,
    agent_count: 0,
    git_commit_count: 0,
    content_mode: 'summary',
    project_identity_basis: 'remote',
    project_identity_strong: true,
    generator: { name: 'aitimeline', version: '1.0.0' },
  };
  const data: TimelineData = {
    manifest,
    project: {
      project_id: 'proj_fixture',
      project_name: 'fixture-project',
      canonical_remote_url: 'https://github.com/example/fixture-project',
      identity_basis: 'remote',
      identity_strong: true,
      repositories: [{ repository_id: 'repo_fixture', remote_urls: ['https://github.com/example/fixture-project'] }],
      worktrees: [],
    },
    devices: [{ device_id: 'device-fixture', role: 'both' }],
    agents: [],
    sessions: [],
    tasks: [],
    events: [],
    relations: [],
    commits: [],
    pushes: [],
    sources: [],
    conflicts: [],
    scanReport: {
      operation: 'scan',
      project_id: 'proj_fixture',
      source_device_id: 'device-fixture',
      scanner_device_id: 'device-fixture',
      started_at: '2026-11-17T00:00:00.000Z',
      completed_at: '2026-11-17T00:00:01.000Z',
      sources_discovered: 0,
      sources_scanned: 0,
      sources_failed: 0,
      sources_skipped_unchanged: 0,
      sessions_discovered: 0,
      sessions_matched: 0,
      sessions_candidate_only: 0,
      events_extracted: 0,
      events_rejected: 0,
      git_commits: 0,
      git_pushes: 0,
      agents: [],
      malformed_records: 0,
      redacted_records: 0,
      symlinks_skipped: 0,
      warnings: [],
      errors: [],
    },
  };
  const merged: TimelineData = { ...data, ...overrides };
  if (overrides.events) {
    merged.manifest = {
      ...merged.manifest,
      event_count: merged.events.length,
      session_count: merged.sessions.length,
      agent_count: merged.agents.length,
      git_commit_count: merged.commits.length,
    };
  }
  return merged;
}

export function makeEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  const dedupKey = 'dedup_fixture';
  const event: ActivityEvent = {
    schema_version: '1.0.0',
    event_id: computeEventId(dedupKey),
    dedup_key: dedupKey,
    dedup_tier: 'source_location',
    event_type: 'agent.user_request.submitted',
    project_id: 'proj_fixture',
    device_id: 'device-fixture',
    time: { occurred_at: '2026-11-17T00:00:00.000Z', observed_at: '2026-11-17T00:00:01.000Z' },
    provenance: {
      source_type: 'agent-session',
      source_path: 'fixture/session.jsonl',
      source_path_identity: 'codex/session.jsonl',
      source_record_id: '1',
      capture_method: 'adapter:codex',
      capture_level: 'observed',
    },
    evidence: { level: 'verified' },
    parser: { adapter_id: 'codex', adapter_version: '1.0.0', parser_version: '1.0.0', schema_version: '1.0.0' },
    activity: { role: 'user', content_summary: 'synthetic request' },
  };
  const merged: ActivityEvent = { ...event, ...overrides };
  if (!overrides.content_hash) {
    merged.content_hash = computeContentHash({
      event_type: merged.event_type,
      time: merged.time,
      activity: merged.activity,
      git: merged.git,
    });
  }
  if (!overrides.event_id) merged.event_id = computeEventId(merged.dedup_key);
  return merged;
}

export async function fileHash(target: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(await readFile(target)).digest('hex');
}

export async function fileMtime(target: string): Promise<number> {
  return (await stat(target)).mtimeMs;
}

export async function makeUnreadable(target: string): Promise<void> {
  await chmod(target, 0o000);
}

export async function restoreReadable(target: string): Promise<void> {
  await chmod(target, 0o755);
}
