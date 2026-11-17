import { describe, it, expect, beforeEach } from 'vitest';
import { mkdir, writeFile, symlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AlExporterAdapter } from '../src/adapters/al-exporter.js';
import { runScan } from '../src/scan/engine.js';
import { tempDir, createGitRepo } from './helpers/fixtures.js';

interface ExportFile {
  file: string;
  source?: string;
  threadId?: string;
  record?: unknown;
  /** Include a manifest item without writing the file. */
  missing?: boolean;
  symlinkTo?: string;
}

async function writeExport(root: string, files: ExportFile[], exporterVersion = '2.0.0'): Promise<void> {
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
  await writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify(
      {
        exporter_version: exporterVersion,
        schema_version: '1.0.0',
        exported_at: '2026-11-17T00:00:00.000Z',
        sources_seen: [...new Set(items.map((i) => i.source))],
        items,
      },
      null,
      2,
    ),
    'utf8',
  );
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

    const claude = await adapter.parseSession(sessions.find((s) => s.native_session_id === 'claude-1')!);
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

  it('rejects an invalid manifest and reports it as a source failure', async () => {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'manifest.json'), '{"items": "not-an-array"}', 'utf8');
    const sources = await new AlExporterAdapter().discoverSources({ roots: [root] });
    const matched = sources.find((s) => s.metadata?.matched_layout === true)!;
    await expect(new AlExporterAdapter().scanSessions(matched)).rejects.toThrow(/missing items/);
  });
});
