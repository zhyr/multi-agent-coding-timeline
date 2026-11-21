import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { DatabaseSync as DatabaseSyncConstructor } from 'node:sqlite';
import {
  buildCursorSupplemental,
  listCursorGlobalComposers,
  parseCursorComposer,
} from '../src/adapters/cursor-global.js';
import { CursorAdapter } from '../src/adapters/cursor.js';
import { writePackage } from '../src/package/writer.js';
import { emptyTimeline } from '../src/package/model.js';
import type { AgentSource } from '../src/adapters/types.js';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncConstructor;
};

const MAIN = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const HEADER_ONLY = '33333333-3333-4333-8333-333333333333';

let root: string;
let dbPath: string;

function source(): AgentSource {
  return {
    source_id: 'cursor-global-fixture',
    agent_id: 'cursor',
    root,
    display_path: root,
    format: 'jsonl+sqlite',
    discovered_from: 'fixture',
    readable: true,
    metadata: { matched_layout: true },
  };
}

function createFixture(): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    CREATE TABLE composerHeaders (
      composerId TEXT PRIMARY KEY,
      workspaceId TEXT,
      createdAt INTEGER,
      lastUpdatedAt INTEGER,
      isArchived INTEGER,
      isSubagent INTEGER
    );
  `);
  const now = Date.UTC(2026, 10, 20, 1, 2, 3);
  const header = db.prepare(
    'INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent) VALUES (?,?,?,?,?,?)',
  );
  header.run(MAIN, 'ws1', now, now + 60_000, 0, 0);
  header.run(HEADER_ONLY, 'ws1', now + 120_000, now + 130_000, 0, 0);

  const kv = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
  kv.run(`composerData:${MAIN}`, JSON.stringify({
    composerId: MAIN,
    name: 'Modern composer',
    createdAt: now,
    lastUpdatedAt: now + 60_000,
    modelConfig: { modelName: 'cursor-large' },
    workspaceIdentifier: { id: 'ws1' },
    fullConversationHeadersOnly: [
      { bubbleId: 'b1', type: 1, createdAt: now + 1000 },
      { bubbleId: 'b2', type: 2, createdAt: now + 2000 },
      { bubbleId: 'b4', type: 2, createdAt: now + 4000 },
      { bubbleId: 'b-missing', type: 2, createdAt: now + 5000 },
    ],
    conversationMap: {
      b4: { type: 2, text: 'from conversationMap', createdAt: now + 4000 },
    },
  }));
  kv.run(`bubbleId:${MAIN}:b1`, JSON.stringify({ type: 1, text: 'hello modern cursor', createdAt: now + 1000 }));
  kv.run(`bubbleId:${MAIN}:b2`, JSON.stringify({
    type: 2,
    text: 'answer body',
    thinking: { text: 'reasoning trace' },
    toolFormerData: {
      tool: 'read_file',
      toolCallId: 'call-1',
      status: 'completed',
      params: { path: 'a.ts' },
      result: 'file body',
    },
    codeBlocks: [{ uri: 'file:///tmp/proj/a.ts', content: 'const a = 1;' }],
    createdAt: now + 2000,
  }));

  kv.run(`composerData:${CHILD}`, JSON.stringify({
    composerId: CHILD,
    createdAt: now + 70_000,
    lastUpdatedAt: now + 80_000,
    subagentInfo: { parentComposerId: MAIN, typeName: 'explore' },
    fullConversationHeadersOnly: [{ bubbleId: 'c1', type: 1, createdAt: now + 70_000 }],
  }));
  kv.run(`bubbleId:${CHILD}:c1`, JSON.stringify({ type: 1, text: 'child task prompt', createdAt: now + 70_000 }));

  kv.run(`bubbleId:ghost:b1`, JSON.stringify({ type: 1, text: 'orphan' }));
  kv.run(`agentKv:artifact:${MAIN}:artifact-1`, new Uint8Array([0, 1, 2, 3]));
  kv.run(`agentKv:blob:abcdef`, new Uint8Array([9, 9]));
  kv.run(`checkpointId:${MAIN}:cp1`, JSON.stringify({ step: 1 }));
  db.close();
}

beforeAll(async () => {
  root = await import('node:fs/promises').then((m) => m.mkdtemp(path.join(os.tmpdir(), 'aitimeline-cursor-global-')));
  dbPath = path.join(root, 'User/globalStorage/state.vscdb');
  await mkdir(path.dirname(dbPath), { recursive: true });
  await mkdir(path.join(root, 'User/workspaceStorage/ws1'), { recursive: true });
  const fs = await import('node:fs/promises');
  await fs.writeFile(
    path.join(root, 'User/workspaceStorage/ws1/workspace.json'),
    JSON.stringify({ folder: 'file:///tmp/proj' }),
  );
  createFixture();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe('Cursor modern globalStorage reader', () => {
  it('lists composer sessions with index and audit counts', async () => {
    const listing = await listCursorGlobalComposers(source(), dbPath, 'User/globalStorage/state.vscdb', new Set([MAIN]));
    expect(listing.available).toBe(true);
    expect(listing.sessions.map((s) => s.native_session_id).sort()).toEqual([MAIN, CHILD, HEADER_ONLY].sort());

    const main = listing.index.find((e) => e.composer_id === MAIN)!;
    expect(main.header_present).toBe(true);
    expect(main.composer_data_present).toBe(true);
    expect(main.bubble_rows).toBe(2);
    expect(main.ordered_bubbles).toBe(4);
    expect(main.conversation_map_entries).toBe(1);
    expect(main.artifact_files).toBe(1);
    expect(main.artifact_checkpoints).toBe(1);
    expect(main.transcript_match).toBe(true);
    expect(main.cwd).toBe('/tmp/proj');

    const headerOnly = listing.index.find((e) => e.composer_id === HEADER_ONLY)!;
    expect(headerOnly.status).toBe('header_only');
    expect(headerOnly.composer_data_present).toBe(false);

    const child = listing.index.find((e) => e.composer_id === CHILD)!;
    expect(child.is_subagent).toBe(true);
    expect(child.parent_composer_id).toBe(MAIN);
    expect(child.header_present).toBe(false);

    expect(listing.audit.counts.composer_headers).toBe(2);
    expect(listing.audit.counts.composer_data_rows).toBe(2);
    expect(listing.audit.counts.orphan_bubble_rows).toBe(1);
    expect(listing.audit.namespaces.some((n) => n.namespace === 'bubbleId')).toBe(true);
  });

  it('parses composer bodies in Cursor order with thinking and tool lifecycle', async () => {
    const listing = await listCursorGlobalComposers(source(), dbPath, 'User/globalStorage/state.vscdb', new Set([MAIN]));
    const session = listing.sessions.find((s) => s.native_session_id === MAIN)!;
    expect(session.metadata?.kind).toBe('cursor-global-composer');

    const result = await parseCursorComposer(session);
    const stats = (result as unknown as { cursor_composer_stats: Record<string, unknown> }).cursor_composer_stats;
    expect(stats.status).toBe('exported');
    expect(stats.message_count).toBe(4); // user + thinking + assistant text + conversationMap body
    expect(stats.user_message_count).toBe(1);
    expect(stats.assistant_message_count).toBe(3);
    expect(stats.tool_calls).toBe(1);
    expect(stats.thinking_blocks).toBe(1);
    expect(stats.missing_bubbles).toBe(1);
    expect(stats.missing_bubble_ids_sample).toEqual(['b-missing']);

    const contents = result.records.map((r) => r.content ?? '');
    expect(contents).toContain('hello modern cursor');
    expect(contents).toContain('reasoning trace');
    expect(contents).toContain('answer body');
    expect(contents).toContain('from conversationMap');
    expect(contents.indexOf('hello modern cursor')).toBeLessThan(contents.indexOf('reasoning trace'));
    expect(contents.indexOf('reasoning trace')).toBeLessThan(contents.indexOf('answer body'));
    expect(contents.indexOf('answer body')).toBeLessThan(contents.indexOf('from conversationMap'));

    const started = result.records.find((r) => r.event_type === 'agent.session.started')!;
    expect(started.occurred_at).toBe(new Date(Date.UTC(2026, 10, 20, 1, 2, 3)).toISOString());
    expect(started.model).toBe('cursor-large');
    expect(started.metadata?.workspace_id).toBe('ws1');

    const user = result.records.find((r) => r.event_type === 'agent.user_request.submitted')!;
    expect(user.role).toBe('user');
    expect(user.evidence_level).toBe('verified');
    expect(user.metadata?.cursor_bubble_id).toBe('b1');

    const thinking = result.records.find((r) => r.raw_type === 'thinking')!;
    expect(thinking.event_type).toBe('agent.response.received');
    expect(thinking.content).toBe('reasoning trace');

    const toolCall = result.records.find((r) => r.event_type === 'agent.tool.started')!;
    expect(toolCall.tool_name).toBe('read_file');
    expect(toolCall.tool_call_id).toBe('call-1');
    expect(toolCall.content).toContain('a.ts');
    const toolDone = result.records.find((r) => r.event_type === 'agent.tool.completed')!;
    expect(toolDone.content).toBe('file body');

    const assistant = result.records.find((r) => r.event_type === 'agent.response.received' && r.content === 'answer body')!;
    expect(assistant.metadata?.context_refs).toEqual(['/tmp/proj/a.ts']);

    const ended = result.records.find((r) => r.event_type === 'agent.session.ended')!;
    expect(ended.evidence_level).toBe('agent_reported');
    expect(ended.capture_level).toBe('derived');

    expect(result.session_started_at).toBe(new Date(Date.UTC(2026, 10, 20, 1, 2, 3)).toISOString());
    expect(result.project_evidence?.cwd).toBe('/tmp/proj');
    expect(result.truncated).toBe(false);
  });

  it('keeps subagent parent linkage on the session start', async () => {
    const listing = await listCursorGlobalComposers(source(), dbPath, 'User/globalStorage/state.vscdb', new Set());
    const session = listing.sessions.find((s) => s.native_session_id === CHILD)!;
    const result = await parseCursorComposer(session);
    const started = result.records.find((r) => r.event_type === 'agent.session.started')!;
    expect(started.metadata?.is_subagent).toBe(true);
    expect(started.metadata?.parent_composer_id).toBe(MAIN);
    expect(started.metadata?.parent_uuid).toBe(`${MAIN}:session:start`);
  });

  it('builds the composer index and audit with transcript alignment', async () => {
    const listing = await listCursorGlobalComposers(source(), dbPath, 'User/globalStorage/state.vscdb', new Set([MAIN, 'deadbeef-0000-4000-8000-000000000000']));
    const main = listing.sessions.find((s) => s.native_session_id === MAIN)!;
    await parseCursorComposer(main);
    const files = buildCursorSupplemental({
      index: listing.index,
      databases: [listing.audit],
      transcriptIds: new Set([MAIN, 'deadbeef-0000-4000-8000-000000000000']),
    });
    expect(files.map((f) => f.path)).toEqual([
      'sources/cursor-composer-index.jsonl',
      'reports/cursor-audit.json',
    ]);
    const audit = files[1]!.content as Record<string, any>;
    expect(audit.totals.composers).toBe(3);
    expect(audit.alignment.composer_ids_matching_transcript).toBe(1);
    expect(audit.alignment.transcript_sessions_without_composer).toBe(1);
    expect(audit.alignment.transcript_only_sample).toContain('deadbeef-0000-4000-8000-000000000000');
  });

  it('writes supplemental files into the package and checksums them', async () => {
    const listing = await listCursorGlobalComposers(source(), dbPath, 'User/globalStorage/state.vscdb', new Set([MAIN]));
    const files = buildCursorSupplemental({
      index: listing.index,
      databases: [listing.audit],
      transcriptIds: new Set([MAIN]),
    });
    const data = emptyTimeline();
    data.manifest = {
      format: 'ai-coding-timeline',
      format_version: '1.0',
      schema_version: '1.0.0',
      timeline_id: 'timeline-fixture',
      project_id: 'project-fixture',
      project_name: 'fixture',
      created_at: new Date().toISOString(),
      operation: 'scan',
      source_devices: ['device-fixture'],
      event_count: 0,
      session_count: 0,
      agent_count: 0,
      git_commit_count: 0,
      content_mode: 'summary',
      project_identity_basis: 'name',
      project_identity_strong: false,
      generator: { name: 'fixture', version: '0' },
    };
    data.project = {
      project_id: 'project-fixture',
      project_name: 'fixture',
      identity_basis: 'name',
      identity_strong: false,
      repositories: [],
      worktrees: [],
    };
    data.supplemental = files;
    const out = path.join(root, 'package');
    await writePackage(out, data, { overwrite: true });
    const indexText = await readFile(path.join(out, 'sources/cursor-composer-index.jsonl'), 'utf8');
    expect(indexText.trim().split('\n')).toHaveLength(3);
    const checksums = await readFile(path.join(out, 'integrity/checksums.sha256'), 'utf8');
    expect(checksums).toContain('sources/cursor-composer-index.jsonl');
    expect(checksums).toContain('reports/cursor-audit.json');
  });

  it('keeps legacy sqlite databases on the metadata path', async () => {
    const legacyPath = path.join(root, 'ai-tracking.db');
    const db = new DatabaseSync(legacyPath);
    db.exec('CREATE TABLE conversation_summaries (conversationId TEXT, title TEXT, tldr TEXT, model TEXT, mode TEXT, updatedAt INTEGER)');
    db.close();
    const listing = await listCursorGlobalComposers(source(), legacyPath, 'ai-tracking.db', new Set());
    expect(listing.available).toBe(false);
    expect(listing.reason).toBe('not-cursor-global');
  });

  it('wires composer sessions through the CursorAdapter', async () => {
    const adapter = new CursorAdapter();
    const sessions = await adapter.scanSessions(source());
    const composer = sessions.find((s) => s.native_session_id === MAIN);
    expect(composer).toBeTruthy();
    const result = await adapter.parseSession(sessions.find((s) => s.native_session_id === MAIN)!);
    expect(result.records.some((r) => r.content === 'hello modern cursor')).toBe(true);
    const supplemental = adapter.supplementalFiles();
    expect(supplemental.map((f) => f.path)).toContain('sources/cursor-composer-index.jsonl');
    const indexRows = supplemental[0]!.content as Array<Record<string, unknown>>;
    const mainRow = indexRows.find((r) => r.composer_id === MAIN);
    expect(mainRow?.status).toBe('exported');
    expect(mainRow?.message_count).toBe(4);
    expect(mainRow?.user_message_count).toBe(1);
    expect(mainRow?.assistant_message_count).toBe(3);
  });
});
