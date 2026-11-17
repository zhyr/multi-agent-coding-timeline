import { describe, it, expect, beforeEach } from 'vitest';
import { mkdir, writeFile, symlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AlExporterAdapter } from '../src/adapters/al-exporter.js';
import { runScan } from '../src/scan/engine.js';
import { deduplicateEvents } from '../src/merge/dedup.js';
import type { ActivityEvent } from '../src/schema/entities.js';
import { tempDir, createGitRepo, makeEvent } from './helpers/fixtures.js';

interface ExportFile {
  file: string;
  source?: string;
  threadId?: string;
  record?: unknown;
  /** Include a manifest item without writing the file. */
  missing?: boolean;
  symlinkTo?: string;
}

interface ExportOptions {
  schemaVersion?: string;
  device?: Record<string, unknown>;
  interop?: unknown;
}

async function writeExport(
  root: string,
  files: ExportFile[],
  exporterVersion = '2.0.0',
  options: ExportOptions = {},
): Promise<void> {
  await mkdir(root, { recursive: true });
  const items = [];
  for (const [index, entry] of files.entries()) {
    const target = path.join(root, entry.file);
    if (!entry.missing) {
      await mkdir(path.dirname(target), { recursive: true });
      if (entry.symlinkTo) await symlink(entry.symlinkTo, target);
      else await writeFile(target, JSON.stringify(entry.record, null, 2), 'utf8');
    }
    items.push({
      hash: `hash-${index}`,
      sha256: '0'.repeat(64),
      source: entry.source ?? 'codex',
      thread_id: entry.threadId ?? `thread-${index}`,
      file: entry.file,
    });
  }
  const schemaVersion = options.schemaVersion ?? '1.0.0';
  const manifest: Record<string, unknown> = {
    exporter_version: exporterVersion,
    schema_version: schemaVersion,
    exported_at: '2026-11-17T00:00:00.000Z',
    sources_seen: [...new Set(items.map((i) => i.source))],
    items,
  };
  if (options.device) manifest.device = options.device;
  if (options.interop !== undefined && schemaVersion === '1.1.0') {
    manifest.contract = {
      name: 'al-exporter-interop',
      version: '1.0.0',
      schema_version: '1.1.0',
      capabilities: 'interop.json',
    };
    await writeFile(
      path.join(root, 'interop.json'),
      typeof options.interop === 'string' ? options.interop : JSON.stringify(options.interop, null, 2),
      'utf8',
    );
  }
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

function thread(options: {
  messages?: unknown;
  source?: string;
  project?: string;
  filePath?: string;
  extra?: Record<string, unknown>;
  createdAt?: string;
  type?: string;
} = {}): unknown {
  return {
    schema_version: '1.0.0',
    thread_id: 'thread-0',
    type: options.type ?? 'thread',
    title: 'fixture thread',
    messages: options.messages ?? [
      { role: 'user', content: 'Please add the importer', timestamp: '2026-11-17T01:00:00.000Z' },
      { role: 'assistant', content: 'Importer added', timestamp: '2026-11-17T01:00:05.000Z' },
    ],
    context: { files: ['src/index.ts'], diffs: [] },
    meta: {
      source: options.source ?? 'codex',
      project: options.project ?? '10',
      created_at: options.createdAt ?? '2000-01-01T00:00:00.000Z',
      file_path: options.filePath ?? '/Users/alice/.codex/sessions/2026/11/17/rollout-thread-0.jsonl',
      extra: options.extra ?? {},
    },
  };
}

async function loadSessions(root: string) {
  const adapter = new AlExporterAdapter();
  const sources = await adapter.discoverSources({ roots: [root] });
  const source = sources.find((s) => s.metadata?.matched_layout === true);
  expect(source).toBeTruthy();
  const sessions = await adapter.scanSessions(source!);
  return { adapter, source: source!, sessions };
}

describe('Al-exporter import adapter', () => {
  let root: string;
  beforeEach(async () => {
    root = await tempDir('aitimeline-al-export-');
  });

  it('discovers only an explicit source root that contains manifest.json', async () => {
    const adapter = new AlExporterAdapter();
    expect(await adapter.discoverSources()).toEqual([]);

    const bare = path.join(root, 'bare');
    await mkdir(bare, { recursive: true });
    const bareSources = await adapter.discoverSources({ roots: [bare] });
    expect(bareSources.every((s) => s.metadata?.matched_layout !== true)).toBe(true);

    const parent = path.join(root, 'archive');
    await writeExport(path.join(parent, 'agent-backup'), [{ file: 'codex/thread-0.json', record: thread() }]);
    const sources = await adapter.discoverSources({ roots: [parent] });
    const matched = sources.find((s) => s.metadata?.matched_layout === true);
    expect(matched?.root).toBe(path.join(parent, 'agent-backup'));

    const direct = await adapter.discoverSources({ roots: [path.join(parent, 'agent-backup')] });
    expect(direct.some((s) => s.metadata?.matched_layout === true)).toBe(true);
  });

  it('maps manifest items and messages, using only message timestamps', async () => {
    await writeExport(root, [{ file: 'codex/thread-0.json', record: thread() }]);
    const { adapter, sessions } = await loadSessions(root);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.native_session_id).toBe('thread-0');
    expect(sessions[0]!.relative_path).toBe('codex/thread-0.json');

    const parsed = await adapter.parseSession(sessions[0]!);
    expect(parsed.issues).toEqual([]);
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0]).toMatchObject({
      event_type: 'agent.user_request.submitted',
      occurred_at: '2026-11-17T01:00:00.000Z',
      evidence_level: 'agent_reported',
      capture_level: 'derived',
      agent_override: { id: 'codex', name: 'Codex', version: 'al-exporter-2.0.0' },
      raw_payload_ref: '/Users/alice/.codex/sessions/2026/11/17/rollout-thread-0.jsonl',
    });
    expect(parsed.records[1]!.event_type).toBe('agent.response.received');
    expect(parsed.records[1]!.native_event_id).toBe('thread-0:m1');
    expect(parsed.session_started_at).toBe('2026-11-17T01:00:00.000Z');
    expect(parsed.session_ended_at).toBe('2026-11-17T01:00:05.000Z');
    // meta.created_at is a file mtime and must never become an event time.
    expect(parsed.records.every((r) => r.occurred_at !== '2000-01-01T00:00:00.000Z')).toBe(true);
  });

  it('leaves occurred_at empty when a message has no timestamp', async () => {
    await writeExport(root, [
      {
        file: 'codex/thread-0.json',
        record: thread({ messages: [{ role: 'user', content: 'no timestamp here' }] }),
      },
    ]);
    const { adapter, sessions } = await loadSessions(root);
    const parsed = await adapter.parseSession(sessions[0]!);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]!.occurred_at).toBeUndefined();
    expect(parsed.session_started_at).toBeUndefined();
  });

  it('isolates missing fields instead of fabricating records', async () => {
    await writeExport(root, [
      { file: 'codex/no-messages.json', threadId: 'no-messages', record: { thread_id: 'x', meta: { source: 'codex' } } },
      {
        file: 'codex/bad-messages.json',
        threadId: 'bad-messages',
        record: {
          thread_id: 'bad-messages',
          meta: { source: 'codex' },
          messages: [
            { content: 'missing role' },
            { role: 'user' },
            { role: 'assistant', content: 'valid message', timestamp: '2026-11-17T02:00:00.000Z' },
            'not-an-object',
          ],
        },
      },
    ]);
    const { adapter, sessions } = await loadSessions(root);
    const noMessages = sessions.find((s) => s.native_session_id === 'no-messages')!;
    const badMessages = sessions.find((s) => s.native_session_id === 'bad-messages')!;

    const empty = await adapter.parseSession(noMessages);
    expect(empty.records).toEqual([]);
    expect(empty.issues[0]!.reason).toMatch(/no messages/);

    const partial = await adapter.parseSession(badMessages);
    expect(partial.records).toHaveLength(1);
    expect(partial.records[0]!.content).toBe('valid message');
    expect(partial.issues.map((i) => i.reason).join(' ')).toMatch(/no role/);
    expect(partial.issues.map((i) => i.reason).join(' ')).toMatch(/no content/);
    expect(partial.issues.map((i) => i.reason).join(' ')).toMatch(/not a JSON object/);
  });

  it('reports malformed JSON as a parse issue', async () => {
    await writeExport(root, [{ file: 'codex/broken.json', record: thread() }]);
    await writeFile(path.join(root, 'codex/broken.json'), '{"thread_id": "broken",', 'utf8');
    const { adapter, sessions } = await loadSessions(root);
    const parsed = await adapter.parseSession(sessions[0]!);
    expect(parsed.records).toEqual([]);
    expect(parsed.issues[0]!.reason).toMatch(/invalid thread JSON/);
  });

  it('maps [Tool Use] text to a tool event without inventing execution status', async () => {
    await writeExport(root, [
      {
        file: 'codex/thread-0.json',
        record: thread({
          messages: [
            { role: 'assistant', content: '[Tool Use] shell\n{"cmd":"npm test"}', timestamp: '2026-11-17T03:00:00.000Z' },
            { role: 'assistant', content: 'Tests pass', timestamp: '2026-11-17T03:00:10.000Z' },
          ],
        }),
      },
    ]);
    const { adapter, sessions } = await loadSessions(root);
    const parsed = await adapter.parseSession(sessions[0]!);
    expect(parsed.records[0]).toMatchObject({
      event_type: 'agent.tool.started',
      tool_name: 'shell',
      evidence_level: 'agent_reported',
      capture_level: 'derived',
    });
    expect(parsed.records[0]!.execution_status).toBeUndefined();
    expect(parsed.records[1]!.event_type).toBe('agent.response.received');
  });

  it('uses WorkBuddy project_directory and decodes file_path hints, ignoring meta.project', async () => {
    await writeExport(root, [
      {
        file: 'workbuddy/thread-0.json',
        source: 'workbuddy',
        threadId: 'wb-1',
        record: thread({
          source: 'workbuddy',
          project: 'fixture-project',
          filePath: '/Users/alice/.workbuddy/sessions/wb-1.json',
          extra: { project_directory: '/Users/alice/work/fixture-project' },
        }),
      },
      {
        file: 'codex/thread-1.json',
        threadId: 'codex-1',
        record: thread({ project: 'anysphere.cursor-retrieval', filePath: '/Users/alice/.codex/sessions/rollout-1.jsonl' }),
      },
      {
        file: 'claude_code/thread-2.json',
        source: 'claude_code',
        threadId: 'claude-1',
        record: thread({
          source: 'claude_code',
          project: 'examples',
          filePath: '/Users/alice/.claude/projects/-Users-alice-work-fixture-project/abc.jsonl',
        }),
      },
    ]);
    const { adapter, sessions } = await loadSessions(root);

    const wb = await adapter.parseSession(sessions.find((s) => s.native_session_id === 'wb-1')!);
    expect(wb.project_evidence?.cwd).toBe('/Users/alice/work/fixture-project');

    const codex = await adapter.parseSession(sessions.find((s) => s.native_session_id === 'codex-1')!);
    expect(codex.project_evidence?.cwd).toBeUndefined();
    expect(codex.project_evidence?.projectPathHints).toBeUndefined();

    const claude = await adapter.parseSession(sessions.find((s) => s.relative_path === 'claude_code/thread-2.json')!);
    expect(claude.project_evidence?.cwd).toBeUndefined();
    expect(claude.project_evidence?.projectPathHints).toEqual(['/Users/alice/work/fixture/project']);
  });

  it('restores the OpenCode agent id from the original file path', async () => {
    await writeExport(root, [
      {
        file: 'codex/thread-0.json',
        record: thread({ source: 'codex', filePath: '/Users/alice/.local/share/opencode/storage/message/x.json' }),
      },
    ]);
    const { adapter, sessions } = await loadSessions(root);
    const parsed = await adapter.parseSession(sessions[0]!);
    expect(parsed.records[0]!.agent_override?.id).toBe('opencode');
  });

  it('skips missing files, symlinks and manifest path traversal', async () => {
    const outside = path.join(root, 'outside.json');
    await writeFile(outside, JSON.stringify(thread()), 'utf8');
    await writeExport(root, [
      { file: 'codex/thread-0.json', record: thread() },
      { file: 'codex/missing.json', missing: true },
      { file: 'codex/link.json', symlinkTo: outside },
      { file: '../outside.json', record: thread() },
    ]);
    const { source, sessions } = await loadSessions(root);
    expect(sessions.map((s) => s.relative_path)).toEqual(['codex/thread-0.json']);
    expect(source.metadata?.missing_items).toBe(1);
    expect(source.metadata?.skipped_symlinks).toBe(1);
  });

  it('treats cross-device cwd evidence as a candidate and preserves two-hop provenance', async () => {
    const projectPath = path.join(root, 'project');
    await createGitRepo(projectPath, { remote: 'https://github.com/example/fixture-project.git', commits: 1 });
    const exportRoot = path.join(root, 'export');
    const rawPath = '/Users/alice/.workbuddy/sessions/wb-1.json';
    await writeExport(exportRoot, [
      {
        file: 'workbuddy/thread-0.json',
        source: 'workbuddy',
        threadId: 'wb-1',
        record: thread({
          source: 'workbuddy',
          project: 'fixture-project',
          filePath: rawPath,
          extra: { project_directory: '/Users/alice/work/fixture-project' },
          messages: [{ role: 'user', content: 'Cross-device request', timestamp: '2026-11-17T05:00:00.000Z' }],
        }),
      },
    ]);
    const before = await readFile(path.join(exportRoot, 'workbuddy/thread-0.json'), 'utf8');

    const excluded = await runScan({
      project: projectPath,
      output: path.join(root, 'excluded.ai-timeline'),
      sourceRoot: exportRoot,
      sourceDevice: 'device-a',
      agents: ['al-exporter'],
    });
    expect(excluded.data.scanReport.sessions_candidate_only).toBe(1);
    expect(excluded.data.events.filter((e) => e.agent?.agent_id === 'workbuddy')).toHaveLength(0);

    const included = await runScan({
      project: projectPath,
      output: path.join(root, 'included.ai-timeline'),
      sourceRoot: exportRoot,
      sourceDevice: 'device-a',
      agents: ['al-exporter'],
      includeCandidates: true,
    });
    const imported = included.data.events.filter((e) => e.agent?.agent_id === 'workbuddy');
    expect(imported).toHaveLength(1);
    const event = imported[0]!;
    expect(event.evidence.level).toBe('agent_reported');
    expect(event.provenance.capture_level).toBe('derived');
    expect(event.provenance.capture_method).toBe('adapter:al-exporter');
    expect(event.provenance.raw_payload_ref).toBe(rawPath);
    expect(event.provenance.source_path.endsWith(path.join('workbuddy', 'thread-0.json'))).toBe(true);
    expect(event.provenance.source_path_identity.startsWith('al-exporter/')).toBe(true);
    expect(event.parser.adapter_id).toBe('al-exporter');
    expect(event.agent?.agent_name).toBe('WorkBuddy');
    expect(event.correlation?.match_confidence).toBe('candidate');
    expect(event.time.occurred_at).toBe('2026-11-17T05:00:00.000Z');
    expect(event.time.occurred_at).not.toBe('2000-01-01T00:00:00.000Z');
    // The adapter never upgrades imported data to verified.
    expect(imported.every((e) => e.evidence.level !== 'verified')).toBe(true);

    expect(await readFile(path.join(exportRoot, 'workbuddy/thread-0.json'), 'utf8')).toBe(before);
  });

  it('recovers native session ids from meta.file_path for layouts native adapters discover', async () => {
    await writeExport(root, [
      {
        file: 'codex/a.json',
        threadId: 'tx-codex',
        record: thread({ filePath: '/Users/alice/.codex/sessions/2026/11/17/rollout-2026-11-17T01-00-00-aaaa-bbbb.jsonl' }),
      },
      {
        file: 'cursor/b.json',
        source: 'cursor',
        threadId: 'tx-cursor',
        record: thread({
          source: 'cursor',
          filePath: '/Users/alice/.cursor/projects/Users-alice-work-proj/agent-transcripts/11111111-2222/11111111-2222.jsonl',
        }),
      },
      {
        file: 'cursor/c.json',
        source: 'cursor',
        threadId: 'tx-subagent',
        record: thread({
          source: 'cursor',
          filePath: '/Users/alice/.cursor/projects/Users-alice-work-proj/agent-transcripts/11111111-2222/subagents/33333333-4444.jsonl',
        }),
      },
      {
        file: 'cursor/d.json',
        source: 'cursor',
        threadId: 'tx-history',
        record: thread({
          source: 'cursor',
          filePath: '/Users/alice/.cursor/projects/Users-alice-work-proj/History/notes.md',
        }),
      },
      {
        file: 'claude_code/e.json',
        source: 'claude_code',
        threadId: 'tx-claude',
        record: thread({
          source: 'claude_code',
          filePath: '/Users/alice/.claude/projects/-Users-alice-work-proj/55555555-6666.jsonl',
        }),
      },
      {
        file: 'qoder/f.json',
        source: 'qoder',
        threadId: 'tx-qoder',
        record: thread({
          source: 'qoder',
          filePath: '/Users/alice/.qoder/projects/Users-alice-work-proj/77777777-8888.jsonl',
        }),
      },
    ]);
    const { adapter, source, sessions } = await loadSessions(root);
    const ids = Object.fromEntries(sessions.map((s) => [s.relative_path, s.native_session_id]));
    expect(ids['codex/a.json']).toBe('2026-11-17T01-00-00-aaaa-bbbb');
    expect(ids['cursor/b.json']).toBe('11111111-2222');
    expect(ids['cursor/c.json']).toBe('33333333-4444');
    expect(ids['claude_code/e.json']).toBe('55555555-6666');
    expect(ids['qoder/f.json']).toBe('77777777-8888');
    // A non-session artifact keeps the Al-exporter thread id: it has no native counterpart.
    expect(ids['cursor/d.json']).toBe('tx-history');
    expect(source.metadata?.native_session_ids_recovered).toBe(5);

    const parsed = await adapter.parseSession(sessions.find((s) => s.relative_path === 'codex/a.json')!);
    expect(parsed.records[1]!.native_event_id).toBe('2026-11-17T01-00-00-aaaa-bbbb:m1');
  });

  it('folds imported events into native ones only on an exact session/content/time match', () => {
    const build = (options: {
      key: string;
      captureMethod: string;
      captureLevel: 'observed' | 'derived';
      session: string;
      content: string;
      occurredAt?: string;
    }): ActivityEvent =>
      makeEvent({
        dedup_key: options.key,
        event_type: 'agent.response.received',
        project_id: 'proj_align',
        device_id: 'device-a',
        agent: {
          agent_id: 'cursor',
          agent_name: 'Cursor',
          native_session_id: options.session,
          native_event_id: options.key,
        },
        activity: { role: 'assistant', content: options.content },
        time: { occurred_at: options.occurredAt, observed_at: '2026-11-17T00:00:01.000Z' },
        provenance: {
          source_type: 'agent-session',
          source_path: options.captureLevel === 'derived' ? 'export/cursor/x.json' : 'sessions/x.jsonl',
          source_path_identity: options.captureLevel === 'derived' ? 'al-exporter/cursor/x.json' : 'cursor/x.jsonl',
          source_record_id: options.key,
          capture_method: options.captureMethod,
          capture_level: options.captureLevel,
        },
        parser: {
          adapter_id: options.captureLevel === 'derived' ? 'al-exporter' : 'cursor',
          adapter_version: '1.0.0',
          parser_version: '1.0.0',
          schema_version: '1.0.0',
        },
      });

    const native = build({
      key: 'native-1',
      captureMethod: 'adapter:cursor',
      captureLevel: 'observed',
      session: 'sess-1',
      content: 'Importer added',
      occurredAt: '2026-11-17T01:00:00.000Z',
    });
    const imported = build({
      key: 'import-1',
      captureMethod: 'adapter:al-exporter',
      captureLevel: 'derived',
      session: 'sess-1',
      content: 'Importer added',
      occurredAt: '2026-11-17T01:00:00.000Z',
    });

    const paired = deduplicateEvents([native, imported]);
    expect(paired.events).toHaveLength(1);
    expect(paired.duplicates).toBe(1);
    expect(paired.inferred_pairs).toBe(1);
    const kept = paired.events[0]!;
    expect(kept.provenance.capture_method).toBe('adapter:cursor');
    expect(kept.provenance.paired_import_event_id).toBeTruthy();
    expect(kept.correlation?.match_confidence).toBe('candidate');
    expect(kept.correlation?.note).toMatch(/inferred pairing/);
    expect(kept.evidence.level).toBe('verified');

    const distinct = (overrides: { session?: string; content?: string; occurredAt?: string }) =>
      build({
        key: `import-${overrides.session ?? ''}-${overrides.content ?? ''}-${overrides.occurredAt ?? ''}`,
        captureMethod: 'adapter:al-exporter',
        captureLevel: 'derived',
        session: overrides.session ?? 'sess-1',
        content: overrides.content ?? 'Importer added',
        occurredAt: overrides.occurredAt ?? '2026-11-17T01:00:00.000Z',
      });

    // A different session, content or timestamp must remain a separate event.
    for (const variant of [
      distinct({ session: 'sess-2' }),
      distinct({ content: 'Something else' }),
      distinct({ occurredAt: '2026-11-17T01:00:00.001Z' }),
    ]) {
      const result = deduplicateEvents([native, variant]);
      expect(result.events).toHaveLength(2);
      expect(result.inferred_pairs).toBe(0);
    }

    // An import without any native counterpart is never dropped.
    const lone = deduplicateEvents([imported]);
    expect(lone.events).toHaveLength(1);
    expect(lone.events[0]!.provenance.capture_method).toBe('adapter:al-exporter');
    expect(lone.inferred_pairs).toBe(0);
  });

  it('consumes 1.1.0 session/device/tool_call fields and message ids', async () => {
    const nativeId = '74d80a47-d27c-4006-857f-e9c044edd5a9';
    const record = {
      schema_version: '1.1.0',
      thread_id: '5ed26a2b5e6e8947',
      type: 'thread',
      messages: [
        { role: 'user', content: 'hi', timestamp: '2026-11-17T01:00:00.000Z', id: 'evt-1', id_source: 'event.id', line: 3 },
        {
          role: 'assistant',
          content: '[Tool Use] Bash\n{"command":"ls"}',
          timestamp: '2026-11-17T01:00:05.000Z',
          id: 'evt-2',
          id_source: 'event.id',
          line: 4,
          tool_call: { name: 'Bash', status: null, call_id: 'call-1', phase: 'call' },
        },
        {
          role: 'user',
          content: '[Tool Result] ok',
          timestamp: '2026-11-17T01:00:06.000Z',
          id: 'evt-3',
          id_source: 'event.id',
          line: 4,
          tool_call: { name: 'Bash', status: 'completed', call_id: 'call-1', phase: 'result' },
        },
        { role: 'assistant', content: 'no id, same line', line: 4 },
        { role: 'assistant', content: 'no id, no line' },
      ],
      meta: {
        source: 'workbuddy',
        project: 'Users-alice-work-fixture-project',
        created_at: '2000-01-01T00:00:00.000Z',
        file_path: `/Users/alice/.workbuddy/projects/Users-alice-work-fixture-project/${nativeId}.jsonl`,
        extra: { project_directory: '/should/not/be/used' },
      },
      session: {
        native_id: nativeId,
        native_id_kind: 'uuid',
        native_id_source: 'file.basename',
        cwd: '/Users/alice/work/fixture-project',
        cwd_source: 'workbuddy.record',
        git_remote: 'https://github.com/example/fixture-project.git',
        git_remote_source: 'cwd_git_config',
        agent_version: '1.2.3',
      },
      device: {
        source_device_id: 'dev_archive',
        source_device_id_basis: 'export_host',
        source_hostname: 'fixture-host',
        collector_device_id: 'dev_archive',
        collector_hostname: 'fixture-host',
        collector_platform: 'darwin',
      },
    };
    await writeExport(
      root,
      [{ file: 'workbuddy/thread-0.json', source: 'workbuddy', threadId: 'tx-1', record }],
      '2.3.0',
      {
        schemaVersion: '1.1.0',
        device: record.device,
        interop: {
          contract: 'al-exporter-interop',
          contract_version: '1.0.0',
          schema_version: '1.1.0',
          records_total: 1,
          messages_total: 5,
          capabilities: { native_session_id: 'full', tool_call_name: 'full', tool_call_status: 'partial' },
          fields: {
            'session.native_id': { schema_present: true, applicable: 1, non_empty: 1, status: 'full' },
            'session.agent_version': { schema_present: true, applicable: 1, non_empty: 0, empty: 1, status: 'empty' },
            'messages[].id': { schema_present: true, applicable: 5, non_empty: 3, empty: 2, status: 'partial' },
          },
        },
      },
    );

    const { adapter, sessions } = await loadSessions(root);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.native_session_id).toBe(nativeId);
    expect(sessions[0]!.metadata?.al_exporter_session_id_source).toBe('session.native_id');
    expect(sessions[0]!.project_evidence.cwd).toBe('/Users/alice/work/fixture-project');
    expect(sessions[0]!.project_evidence.gitRemote).toBe('https://github.com/example/fixture-project.git');
    expect(sessions[0]!.project_evidence.metadata).toMatchObject({
      cwd_source: 'workbuddy.record',
      git_remote_source: 'cwd_git_config',
    });
    // A 1.1.0 session block wins; the 1.0.0 extra.project_directory is not used.
    expect(sessions[0]!.project_evidence.cwd).not.toBe('/should/not/be/used');

    const declared = await adapter.declaredSourceDevice(sessions[0]!.source);
    expect(declared).toMatchObject({ device_id: 'dev_archive', basis: 'export_host', source: 'manifest.device' });

    const parsed = await adapter.parseSession(sessions[0]!);
    expect(parsed.issues).toEqual([]);
    expect(parsed.records.map((r) => r.native_event_id)).toEqual([
      'evt-1',
      'evt-2',
      'evt-3',
      `session:${nativeId}:L4`,
      `${nativeId}:m4`,
    ]);
    expect(parsed.records.map((r) => r.import_identity_source)).toEqual([
      'message_id',
      'message_id',
      'message_id',
      'session_line',
      'message_index',
    ]);
    expect(parsed.records[1]).toMatchObject({
      event_type: 'agent.tool.started',
      tool_name: 'Bash',
      tool_call_id: 'call-1',
    });
    // status: null means "not recorded"; it is never turned into success/failure.
    expect(parsed.records[1]!.execution_status).toBeUndefined();
    expect(parsed.records[2]).toMatchObject({
      event_type: 'agent.tool.completed',
      execution_status: 'completed',
      tool_call_id: 'call-1',
    });
    expect(parsed.records[0]!.agent_override?.version).toBe('1.2.3');
    expect(parsed.project_evidence?.gitRemote).toBe('https://github.com/example/fixture-project.git');

    const capabilities = adapter.getCapabilities();
    expect(capabilities.interop).toMatchObject({ schema_version: '1.1.0', records_total: 1 });
    expect(capabilities.notes.join(' ')).toMatch(/session\.agent_version=0\/1 non-empty \(empty\)/);
    expect(capabilities.tool_calls).toBe('verified');
  });

  it('distinguishes absent interop fields from empty ones', async () => {
    await writeExport(
      root,
      [{ file: 'workbuddy/thread-0.json', source: 'workbuddy', record: thread({ source: 'workbuddy' }) }],
      '2.3.0',
      {
        schemaVersion: '1.1.0',
        interop: {
          contract: 'al-exporter-interop',
          schema_version: '1.1.0',
          capabilities: {
            session_cwd: 'empty',
            git_remote: 'absent',
            message_timestamp: 'empty',
            tool_call_name: 'empty',
          },
          fields: {
            'session.cwd': { schema_present: true, applicable: 1, non_empty: 0, empty: 1, status: 'empty' },
            'messages[].tool_call.name': {
              schema_present: true,
              applicable: 2,
              non_empty: 0,
              empty: 2,
              status: 'empty',
            },
          },
          known_gaps: ['fixture: schema present but no data'],
        },
      },
    );
    const { adapter } = await loadSessions(root);
    const capabilities = adapter.getCapabilities();
    // Schema presence alone never upgrades a capability.
    expect(capabilities.tool_calls).toBe('unavailable');
    expect(capabilities.timestamps).toBe('unavailable');
    expect(capabilities.project_identity).toBe('unavailable');
    expect(capabilities.notes.join(' ')).toMatch(/messages\[\]\.tool_call\.name=0\/2 non-empty \(empty\)/);
    expect(capabilities.notes.join(' ')).toMatch(/git_remote=absent/);
    expect(capabilities.interop).toMatchObject({
      fields: { 'session.cwd': { schema_present: true, status: 'empty', non_empty: 0 } },
    });

    // 1.0.0 has no interop.json: absent and empty cannot be distinguished.
    const legacyRoot = path.join(root, 'legacy');
    await writeExport(legacyRoot, [{ file: 'codex/thread-0.json', record: thread() }]);
    const legacy = new AlExporterAdapter();
    const legacySource = (await legacy.discoverSources({ roots: [legacyRoot] })).find(
      (s) => s.metadata?.matched_layout === true,
    )!;
    await legacy.scanSessions(legacySource);
    expect(legacy.getCapabilities().interop).toBeUndefined();
    expect(legacy.getCapabilities().notes.join(' ')).toMatch(/No interop\.json/);
  });

  it('adopts the archive device, reports conflicts and lets --source-device win', async () => {
    const projectPath = path.join(root, 'project');
    await createGitRepo(projectPath, { remote: 'https://github.com/example/device-project.git', commits: 1 });
    const exportRoot = path.join(root, 'export');
    const record = {
      schema_version: '1.1.0',
      thread_id: 'tx-device',
      type: 'thread',
      messages: [{ role: 'user', content: 'device fixture', timestamp: '2026-11-17T05:00:00.000Z', id: 'evt-d' }],
      meta: {
        source: 'workbuddy',
        file_path: '/Users/alice/.workbuddy/projects/x/sess-device.jsonl',
      },
      session: {
        native_id: 'sess-device',
        cwd: projectPath,
        cwd_source: 'workbuddy.record',
        git_remote: 'https://github.com/example/device-project.git',
        git_remote_source: 'cwd_git_config',
      },
      device: { source_device_id: 'dev_archive', source_device_id_basis: 'export_host' },
    };
    await writeExport(
      exportRoot,
      [{ file: 'workbuddy/thread-0.json', source: 'workbuddy', threadId: 'tx-device', record }],
      '2.3.0',
      { schemaVersion: '1.1.0', device: record.device, interop: { schema_version: '1.1.0', capabilities: {}, fields: {} } },
    );

    const adopted = await runScan({
      project: projectPath,
      output: path.join(root, 'adopted.ai-timeline'),
      sourceRoot: exportRoot,
      agents: ['al-exporter'],
    });
    expect(adopted.sourceDeviceId).toBe('dev_archive');
    expect(adopted.data.events.some((e) => e.agent?.agent_id === 'workbuddy')).toBe(true);
    expect(adopted.data.scanReport.warnings.join(' ')).toMatch(/adopted from the archive declaration manifest\.device/);

    const conflict = await runScan({
      project: projectPath,
      output: path.join(root, 'conflict.ai-timeline'),
      sourceRoot: exportRoot,
      sourceDevice: 'device-a',
      agents: ['al-exporter'],
    });
    expect(conflict.sourceDeviceId).toBe('device-a');
    expect(conflict.data.scanReport.warnings.join(' ')).toMatch(
      /Device conflict: .*dev_archive.*--source-device device-a/,
    );

    const matching = await runScan({
      project: projectPath,
      output: path.join(root, 'matching.ai-timeline'),
      sourceRoot: exportRoot,
      sourceDevice: 'dev_archive',
      agents: ['al-exporter'],
    });
    expect(matching.data.scanReport.warnings.join(' ')).toMatch(/matches the archive declaration/);
  });

  it('folds matched message ids deterministically and labels fallback identities as inferred', () => {
    const native = makeEvent({
      dedup_key: 'dedup:native:cursor:s1:evt-1',
      dedup_tier: 'native_id',
      event_type: 'agent.response.received',
      project_id: 'proj_align',
      device_id: 'device-a',
      agent: { agent_id: 'cursor', agent_name: 'Cursor', native_session_id: 's1', native_event_id: 'evt-1' },
      activity: { role: 'assistant', content: 'same row' },
      time: { occurred_at: '2026-11-17T01:00:00.000Z', observed_at: '2026-11-17T00:00:01.000Z' },
      provenance: {
        source_type: 'agent-session',
        source_path: 'cursor/s1.jsonl',
        source_path_identity: 'cursor/s1.jsonl',
        source_record_id: 'line:3',
        capture_method: 'adapter:cursor',
        capture_level: 'observed',
      },
      parser: { adapter_id: 'cursor', adapter_version: '1.0.0', parser_version: '1.0.0', schema_version: '1.0.0' },
    });
    const imported = makeEvent({
      dedup_key: 'dedup:native:cursor:s1:evt-1',
      dedup_tier: 'native_id',
      event_type: 'agent.response.received',
      project_id: 'proj_align',
      device_id: 'device-a',
      agent: { agent_id: 'cursor', agent_name: 'Cursor', native_session_id: 's1', native_event_id: 'evt-1' },
      activity: { role: 'assistant', content: 'same row' },
      time: { occurred_at: '2026-11-17T01:00:00.000Z', observed_at: '2026-11-17T00:00:01.000Z' },
      provenance: {
        source_type: 'agent-session',
        source_path: 'export/cursor/s1.json',
        source_path_identity: 'al-exporter/cursor/s1.json',
        source_record_id: 'message:evt-1',
        capture_method: 'adapter:al-exporter',
        capture_level: 'derived',
        import_identity_source: 'message_id',
      },
      parser: { adapter_id: 'al-exporter', adapter_version: '1.1.0', parser_version: '1.1.0', schema_version: '1.0.0' },
    });

    const deterministic = deduplicateEvents([native, imported]);
    expect(deterministic.events).toHaveLength(1);
    expect(deterministic.deterministic_pairs).toBe(1);
    expect(deterministic.inferred_pairs).toBe(0);
    expect(deterministic.events[0]!.provenance.capture_method).toBe('adapter:cursor');
    expect(deterministic.events[0]!.provenance.paired_import_event_id).toBeTruthy();
    expect(deterministic.events[0]!.correlation?.note).toMatch(/deterministic pairing/);
    expect(deterministic.events[0]!.correlation?.match_confidence).toBe('exact');

    // 1.0.0 / no-message-id rows keep the inferred path and are labelled as such.
    const fallback = makeEvent({
      dedup_key: 'dedup:native:cursor:s1:session:s1:L3',
      event_type: 'agent.response.received',
      project_id: 'proj_align',
      device_id: 'device-a',
      agent: { agent_id: 'cursor', agent_name: 'Cursor', native_session_id: 's1', native_event_id: 'session:s1:L3' },
      activity: { role: 'assistant', content: 'same row' },
      time: { occurred_at: '2026-11-17T01:00:00.000Z', observed_at: '2026-11-17T00:00:01.000Z' },
      provenance: {
        source_type: 'agent-session',
        source_path: 'export/cursor/s1.json',
        source_path_identity: 'al-exporter/cursor/s1.json',
        source_record_id: 'message:L3',
        capture_method: 'adapter:al-exporter',
        capture_level: 'derived',
        import_identity_source: 'session_line',
      },
      parser: { adapter_id: 'al-exporter', adapter_version: '1.1.0', parser_version: '1.1.0', schema_version: '1.0.0' },
    });
    const inferred = deduplicateEvents([native, fallback]);
    expect(inferred.events).toHaveLength(1);
    expect(inferred.deterministic_pairs).toBe(0);
    expect(inferred.inferred_pairs).toBe(1);
    expect(inferred.events[0]!.correlation?.note).toMatch(/inferred pairing/);
  });

  it('rejects an invalid manifest and reports it as a source failure', async () => {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'manifest.json'), '{"items": "not-an-array"}', 'utf8');
    const sources = await new AlExporterAdapter().discoverSources({ roots: [root] });
    const matched = sources.find((s) => s.metadata?.matched_layout === true)!;
    await expect(new AlExporterAdapter().scanSessions(matched)).rejects.toThrow(/missing items/);
  });
});
