/**
 * Modern Cursor desktop Composer reader (globalStorage `state.vscdb`).
 *
 * Cursor ≥ 0.45 writes desktop Composer conversations into
 *   <userData>/globalStorage/state.vscdb
 *   - composerHeaders  : one row per composer (ids, workspace, timestamps)
 *   - cursorDiskKV     : composerData:<id>, bubbleId:<id>:<bubble>,
 *                        checkpointId:…, agentKv:{blob,artifact,checkpoint,…
 *
 * This module only reads. It reconstructs each composer in Cursor's own order
 * (`fullConversationHeadersOnly` → `conversationMap` → `bubbleId` rows) and
 * emits adapter-neutral records. Composer-level facts (header/data presence,
 * bubble counts, subagent linkage, agentKv artifacts) are returned as index
 * rows so the package can carry a session index plus an audit report.
 */

import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { AgentSource, ParseIssue, ParseResult, ProjectEvidence, SessionReference, SupplementalFile } from './types.js';
import { openReadOnlySqlite, parseTimestamp, safeSqliteRows, type SqliteLike } from './util.js';

const MAX_COMPOSERS = 20000;
const MAX_BUBBLES_PER_COMPOSER = 20000;
const MAX_ARTIFACT_KEYS = 200000;

export interface CursorIndexRow {
  composer_id: string;
  db_path: string;
  name?: string;
  model?: string;
  workspace_id?: string;
  cwd?: string;
  created_at?: string;
  updated_at?: string;
  is_subagent: boolean;
  parent_composer_id?: string;
  header_present: boolean;
  composer_data_present: boolean;
  bubble_rows: number;
  ordered_bubbles: number;
  conversation_map_entries: number;
  message_count: number;
  user_message_count: number;
  assistant_message_count: number;
  tool_calls: number;
  thinking_blocks: number;
  code_block_refs: number;
  missing_bubbles: number;
  missing_bubble_ids_sample: string[];
  unparsable_bubbles: number;
  empty_bubbles: number;
  artifact_blobs: number;
  artifact_checkpoints: number;
  artifact_files: number;
  artifact_bytes: number;
  status: 'pending' | 'exported' | 'empty' | 'header_only' | 'error';
  transcript_match: boolean;
  /** Filled by the adapter after parsing. */
  session_id?: string;
}

export interface CursorAuditDatabase {
  db_path: string;
  schema: Record<string, unknown>;
  counts: Record<string, number>;
  namespaces: Array<{ namespace: string; rows: number; bytes: number }>;
  issues: string[];
}

export interface CursorGlobalListing {
  available: boolean;
  reason?: string;
  sessions: SessionReference[];
  index: CursorIndexRow[];
  audit: CursorAuditDatabase;
}

interface MessageNode {
  [key: string]: unknown;
}

function valueToText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return String(value);
}

function parseJsonValue(value: unknown): unknown {
  const text = valueToText(value);
  if (!text || !text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toIso(value: unknown): string | undefined {
  const parsed = parseTimestamp(value);
  return parsed.iso;
}

function tableNames(db: SqliteLike, onError: (m: string) => void): Set<string> {
  return new Set(
    safeSqliteRows(db, "SELECT name FROM sqlite_master WHERE type IN ('table','view')", onError)
      .map((r) => String(r.name)),
  );
}

function tableColumns(db: SqliteLike, table: string, onError: (m: string) => void): string[] {
  return safeSqliteRows(db, `PRAGMA table_info(${table})`, onError).map((r) => String(r.name));
}

/** Recursively locate the message body inside Cursor's version-specific envelope. */
function findMessageNode(node: unknown, depth = 0): MessageNode | undefined {
  if (!node || typeof node !== 'object' || depth > 6) return undefined;
  if (Array.isArray(node)) {
    for (const item of node.slice(0, 8)) {
      const found = findMessageNode(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const record = node as Record<string, unknown>;
  for (const key of ['text', 'toolFormerData', 'codeBlocks', 'thinking', 'richText']) {
    if (key in record) return record;
  }
  for (const key of ['bubble', 'message', 'data', 'document', 'value', 'payload', 'entries']) {
    if (record[key] && typeof record[key] === 'object') {
      const found = findMessageNode(record[key], depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function textOf(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        const record = asRecord(part);
        if (!record) return '';
        if (typeof record.text === 'string') return record.text;
        if (typeof record.rawText === 'string') return record.rawText;
        if (typeof record.content === 'string' && (record.type === 'text' || record.type === undefined)) return record.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  const record = asRecord(value);
  if (record) {
    if (typeof record.text === 'string') return record.text;
    if (typeof record.rawText === 'string') return record.rawText;
    if (typeof record.content === 'string') return record.content;
    try { return JSON.stringify(record); } catch { return ''; }
  }
  return String(value);
}

function stringifyUnknown(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function bubbleTypeOf(node: MessageNode): 0 | 1 | 2 {
  const raw = node.type ?? node.messageType ?? node.role;
  if (raw === 1 || raw === '1' || raw === 'human' || raw === 'user') return 1;
  if (raw === 2 || raw === '2' || raw === 'ai' || raw === 'assistant') return 2;
  return 0;
}

function bubbleIdFromKey(key: string, composerId: string): string {
  const prefix = `bubbleId:${composerId}:`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key.split(':').pop() ?? key;
}

function codeBlockRefs(node: MessageNode): string[] {
  const blocks = node.codeBlocks;
  if (!Array.isArray(blocks)) return [];
  const refs: string[] = [];
  for (const block of blocks) {
    const record = asRecord(block);
    if (!record) continue;
    const uri = asString(record.uri) ?? asString(record.file) ?? asString(record.path);
    if (!uri) continue;
    refs.push(uri.startsWith('file://') ? uri.replace(/^file:\/\//, '') : uri);
  }
  return refs;
}

function fileUriToPath(value: unknown): string | undefined {
  const text = asString(value);
  if (!text) return undefined;
  if (!text.startsWith('file://')) return text;
  try { return decodeURIComponent(text.replace(/^file:\/\//, '')); } catch { return undefined; }
}

function projectEvidenceFor(cwd: string | undefined, workspaceId: string | undefined): ProjectEvidence {
  const evidence: ProjectEvidence = {};
  if (cwd) {
    evidence.cwd = cwd;
    evidence.projectPathHints = [cwd];
  }
  if (workspaceId) {
    evidence.nativeProjectId = workspaceId;
    evidence.metadata = { ...(evidence.metadata ?? {}), workspace_id: workspaceId };
  }
  return evidence;
}

async function resolveWorkspaceCwd(
  dbPath: string,
  workspaceId: string | undefined,
  cache: Map<string, string | undefined>,
): Promise<string | undefined> {
  if (!workspaceId) return undefined;
  if (cache.has(workspaceId)) return cache.get(workspaceId);
  const workspaceStorage = path.join(path.dirname(path.dirname(dbPath)), 'workspaceStorage');
  let cwd: string | undefined;
  try {
    const parsed = JSON.parse(await readFile(path.join(workspaceStorage, workspaceId, 'workspace.json'), 'utf8')) as Record<string, unknown>;
    cwd = fileUriToPath(parsed.folder) ?? fileUriToPath(parsed.workspace);
  } catch {
    cwd = undefined;
  }
  cache.set(workspaceId, cwd);
  return cwd;
}

function composerFields(data: Record<string, unknown> | undefined) {
  const headers = Array.isArray(data?.fullConversationHeadersOnly)
    ? (data?.fullConversationHeadersOnly as unknown[])
        .map((h) => asString(asRecord(h)?.bubbleId))
        .filter((v): v is string => !!v)
    : [];
  const conversationMap = asRecord(data?.conversationMap);
  const subagentInfo = asRecord(data?.subagentInfo);
  const workspaceId = asString(asRecord(data?.workspaceIdentifier)?.id) ?? asString(data?.workspaceId);
  const parentComposerId = asString(subagentInfo?.parentComposerId) ?? asString(data?.parentComposerId);
  const composerId = asString(data?.composerId);
  const isSubagent =
    data?.isSubagent === true ||
    !!parentComposerId ||
    (Array.isArray(data?.subagentComposerIds) && (data?.subagentComposerIds as unknown[]).length > 0) ||
    (composerId ? /(^|:)task-/.test(composerId) : false);
  return {
    headers,
    conversationMap,
    workspaceId,
    parentComposerId,
    isSubagent,
    name: asString(data?.name),
    model: asString(asRecord(data?.modelConfig)?.modelName) ?? asString(data?.model) ?? asString(data?.modelName),
    createdAt: toIso(data?.createdAt),
    updatedAt: toIso(data?.lastUpdatedAt),
  };
}

function namespaceOf(key: string): string {
  const index = key.indexOf(':');
  return index > 0 ? key.slice(0, index) : key;
}

function artifactComposerOf(key: string): string | undefined {
  if (key.startsWith('agentKv:blob:')) return undefined;
  if (key.startsWith('checkpointId:')) {
    const rest = key.slice('checkpointId:'.length);
    const end = rest.indexOf(':');
    return end > 0 ? rest.slice(0, end) : (rest || undefined);
  }
  const rest = key.slice(key.indexOf(':') + 1);
  const second = rest.indexOf(':');
  if (second < 0) return undefined;
  const namespace = key.slice(0, key.indexOf(':')) + ':' + rest.slice(0, second);
  if (!['agentKv:artifact', 'agentKv:checkpoint', 'agentKv:bubbleCheckpoint'].includes(namespace)) {
    return undefined;
  }
  const remainder = rest.slice(second + 1);
  const end = remainder.indexOf(':');
  return end >= 0 ? remainder.slice(0, end) : remainder;
}

/**
 * List every desktop Composer in one global database as a SessionReference.
 * Returns `available: false` when the file is not a modern Cursor global DB so
 * the caller can keep the legacy metadata-only behaviour.
 */
export async function listCursorGlobalComposers(
  source: AgentSource,
  dbPath: string,
  relativePath: string,
  transcriptIds: ReadonlySet<string>,
): Promise<CursorGlobalListing> {
  const issues: string[] = [];
  const db = await openReadOnlySqlite(dbPath);
  const audit: CursorAuditDatabase = {
    db_path: dbPath,
    schema: {},
    counts: {},
    namespaces: [],
    issues,
  };
  if (!db) {
    issues.push('node:sqlite unavailable or database could not be opened read-only');
    return { available: false, reason: 'sqlite-unavailable', sessions: [], index: [], audit };
  }
  try {
    const tables = tableNames(db, (m) => issues.push(`schema query failed: ${m}`));
    if (!tables.has('cursorDiskKV') || !tables.has('composerHeaders')) {
      return { available: false, reason: 'not-cursor-global', sessions: [], index: [], audit };
    }
    const statInfo = await stat(dbPath).catch(() => undefined);
    const schema: Record<string, unknown> = {
      user_version: safeSqliteRows(db, 'PRAGMA user_version', (m) => issues.push(m))[0]?.user_version,
      composer_header_columns: tableColumns(db, 'composerHeaders', (m) => issues.push(m)),
      cursor_disk_kv_columns: tableColumns(db, 'cursorDiskKV', (m) => issues.push(m)),
      has_remote_agent_headers: tables.has('remoteAgentHeaders'),
    };
    audit.schema = schema;

    audit.namespaces = safeSqliteRows(
      db,
      `SELECT CASE WHEN instr(key, ':') > 0 THEN substr(key, 1, instr(key, ':') - 1) ELSE key END AS namespace,
              COUNT(*) AS rows, COALESCE(SUM(LENGTH(value)), 0) AS bytes
       FROM cursorDiskKV GROUP BY namespace ORDER BY rows DESC`,
      (m) => issues.push(`namespace inventory failed: ${m}`),
    ).map((r) => ({ namespace: String(r.namespace), rows: Number(r.rows ?? 0), bytes: Number(r.bytes ?? 0) }));

    const bubbleStats = new Map<string, { rows: number; bytes: number }>();
    for (const row of safeSqliteRows(
      db,
      `SELECT substr(key, 10, instr(substr(key, 10), ':') - 1) AS composer_id,
              COUNT(*) AS rows, COALESCE(SUM(LENGTH(value)), 0) AS bytes
       FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'
       GROUP BY composer_id`,
      (m) => issues.push(`bubble inventory failed: ${m}`),
    )) {
      bubbleStats.set(String(row.composer_id), {
        rows: Number(row.rows ?? 0),
        bytes: Number(row.bytes ?? 0),
      });
    }

    const artifactStats = new Map<string, { blobs: number; checkpoints: number; files: number; bytes: number }>();
    for (const row of safeSqliteRows(
      db,
      `SELECT key, LENGTH(value) AS bytes FROM cursorDiskKV
       WHERE key LIKE 'agentKv:%' OR key LIKE 'checkpointId:%'
       LIMIT ${MAX_ARTIFACT_KEYS}`,
      (m) => issues.push(`artifact inventory failed: ${m}`),
    )) {
      const key = String(row.key);
      const bytes = Number(row.bytes ?? 0);
      const composerId = artifactComposerOf(key) ?? '_shared';
      const entry = artifactStats.get(composerId) ?? { blobs: 0, checkpoints: 0, files: 0, bytes: 0 };
      entry.bytes += bytes;
      if (key.startsWith('agentKv:blob:')) entry.blobs += 1;
      else if (key.startsWith('agentKv:artifact:')) entry.files += 1;
      else entry.checkpoints += 1;
      artifactStats.set(composerId, entry);
    }

    const headers = new Map<string, Record<string, unknown>>();
    const headerColumns = tableColumns(db, 'composerHeaders', (m) => issues.push(m));
    const headerSelect = ['composerId', 'workspaceId', 'createdAt', 'lastUpdatedAt', 'isArchived', 'isSubagent']
      .filter((column) => headerColumns.includes(column));
    if (headerSelect.length > 0) {
      for (const row of safeSqliteRows(
        db,
        `SELECT ${headerSelect.map((c) => `"${c}"`).join(', ')} FROM composerHeaders`,
        (m) => issues.push(`composerHeaders query failed: ${m}`),
      )) {
        const id = asString(row.composerId);
        if (id) headers.set(id, row);
      }
    }
    const headerIds = [...headers.keys()];

    const composerKeys = safeSqliteRows(
      db,
      "SELECT key FROM cursorDiskKV WHERE key LIKE 'composerData:%'",
      (m) => issues.push(`composerData listing failed: ${m}`),
    ).map((r) => String(r.key));
    const composerIds = composerKeys.map((key) => key.slice('composerData:'.length));

    const allIds = [...new Set([...headerIds, ...composerIds])].sort();
    if (allIds.length > MAX_COMPOSERS) {
      issues.push(`composer count ${allIds.length} exceeds cap ${MAX_COMPOSERS}; remaining composers were not listed`);
    }
    const listed = allIds.slice(0, MAX_COMPOSERS);

    const sessions: SessionReference[] = [];
    const index: CursorIndexRow[] = [];
    const workspaceCache = new Map<string, string | undefined>();
    let headerOnly = 0;
    let dataWithoutHeader = 0;

    for (const composerId of listed) {
      const header = headers.get(composerId);
      // Parse composerData one at a time so a multi-gigabyte KV table never has
      // to be materialized in memory at once.
      const row = safeSqliteRows(
        db,
        'SELECT value FROM cursorDiskKV WHERE key = ?',
        (m) => issues.push(`composerData ${composerId} query failed: ${m}`),
        [`composerData:${composerId}`],
      )[0];
      const data = row ? asRecord(parseJsonValue(row.value)) : undefined;
      if (!data) headerOnly += 1;
      if (data && !header) dataWithoutHeader += 1;
      const fields = composerFields(data);
      const workspaceId = fields.workspaceId ?? asString(header?.workspaceId);
      const cwd = await resolveWorkspaceCwd(dbPath, workspaceId, workspaceCache);
      const createdAt = fields.createdAt ?? toIso(header?.createdAt);
      const updatedAt = fields.updatedAt ?? toIso(header?.lastUpdatedAt) ?? createdAt;
      const bubble = bubbleStats.get(composerId) ?? { rows: 0, bytes: 0 };
      const artifact = artifactStats.get(composerId) ?? { blobs: 0, checkpoints: 0, files: 0, bytes: 0 };
      const isSubagent = fields.isSubagent || header?.isSubagent === 1;
      const transcriptMatch = transcriptIds.has(composerId.toLowerCase());

      const session: SessionReference = {
        native_session_id: composerId,
        source,
        path: dbPath,
        relative_path: `${relativePath}#composer/${composerId}`,
        size_bytes: bubble.bytes + (artifact.bytes ?? 0),
        modified_at: statInfo ? statInfo.mtime.toISOString() : undefined,
        project_evidence: projectEvidenceFor(cwd, workspaceId),
        // The composer lives inside a shared multi-GB database; hashing the
        // whole DB per composer cannot prove one composer is unchanged.
        incremental_unsafe: true,
        metadata: {
          kind: 'cursor-global-composer',
          cursor_db_path: dbPath,
          composer_id: composerId,
          workspace_id: workspaceId,
          cwd,
          is_subagent: isSubagent,
          parent_composer_id: fields.parentComposerId,
          cursor_created_at: createdAt,
          cursor_updated_at: updatedAt,
          header_present: !!header,
          composer_data_present: !!data,
          transcript_match: transcriptMatch,
        },
      };
      sessions.push(session);
      index.push({
        composer_id: composerId,
        db_path: dbPath,
        name: fields.name,
        model: fields.model,
        workspace_id: workspaceId,
        cwd,
        created_at: createdAt,
        updated_at: updatedAt,
        is_subagent: isSubagent,
        parent_composer_id: fields.parentComposerId,
        header_present: !!header,
        composer_data_present: !!data,
        bubble_rows: bubble.rows,
        ordered_bubbles: fields.headers.length,
        conversation_map_entries: fields.conversationMap ? Object.keys(fields.conversationMap).length : 0,
        message_count: 0,
        user_message_count: 0,
        assistant_message_count: 0,
        tool_calls: 0,
        thinking_blocks: 0,
        code_block_refs: 0,
        missing_bubbles: 0,
        missing_bubble_ids_sample: [],
        unparsable_bubbles: 0,
        empty_bubbles: 0,
        artifact_blobs: artifact.blobs,
        artifact_checkpoints: artifact.checkpoints,
        artifact_files: artifact.files,
        artifact_bytes: artifact.bytes,
        status: data ? 'pending' : 'header_only',
        transcript_match: transcriptMatch,
      });
    }

    const known = new Set(listed);
    let orphanBubbleRows = 0;
    for (const row of safeSqliteRows(
      db,
      `SELECT substr(key, 10, instr(substr(key, 10), ':') - 1) AS composer_id, COUNT(*) AS rows
       FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' GROUP BY composer_id`,
      (m) => issues.push(`orphan bubble query failed: ${m}`),
    )) {
      if (!known.has(String(row.composer_id))) orphanBubbleRows += Number(row.rows ?? 0);
    }
    if (orphanBubbleRows > 0) {
      issues.push(`${orphanBubbleRows} bubble rows belong to composers without a header or composerData row`);
    }

    const remoteHeaderCount = tables.has('remoteAgentHeaders')
      ? Number(safeSqliteRows(db, 'SELECT COUNT(*) AS n FROM remoteAgentHeaders', (m) => issues.push(m))[0]?.n ?? 0)
      : 0;

    audit.counts = {
      composer_headers: headerIds.length,
      composer_data_rows: composerIds.length,
      composers_listed: listed.length,
      remote_agent_headers: remoteHeaderCount,
      headers_without_composer_data: headerOnly,
      composer_data_without_header: dataWithoutHeader,
      subagent_composers: index.filter((e) => e.is_subagent).length,
      transcript_matches: index.filter((e) => e.transcript_match).length,
      orphan_bubble_rows: orphanBubbleRows,
    };
    return { available: true, sessions, index, audit };
  } finally {
    db.close();
  }
}

/**
 * Parse one composer session into adapter-neutral records. `session.metadata`
 * must carry `cursor_db_path` and `composer_id` (set by listCursorGlobalComposers).
 */
export async function parseCursorComposer(session: SessionReference): Promise<ParseResult> {
  const issues: ParseIssue[] = [];
  const dbPath = asString(session.metadata?.cursor_db_path);
  const composerId = asString(session.metadata?.composer_id) ?? session.native_session_id;
  if (!dbPath) {
    return { records: [], issues: [{ line: 0, reason: 'composer session is missing cursor_db_path metadata' }], truncated: true };
  }
  const db = await openReadOnlySqlite(dbPath);
  if (!db) {
    return { records: [], issues: [{ line: 0, reason: 'cursor global database could not be opened read-only' }], truncated: true };
  }
  try {
    const row = safeSqliteRows(
      db,
      'SELECT value FROM cursorDiskKV WHERE key = ?',
      (m) => issues.push({ line: 0, reason: m }),
      [ `composerData:${composerId}` ],
    )[0];
    const data = row ? asRecord(parseJsonValue(row.value)) : undefined;
    if (row && !data) issues.push({ line: 0, reason: `composerData:${composerId} is not valid JSON` });
    const fields = composerFields(data);
    const createdAt = fields.createdAt ?? asString(session.metadata?.cursor_created_at);
    const updatedAt = fields.updatedAt ?? asString(session.metadata?.cursor_updated_at) ?? createdAt;
    const isSubagent = fields.isSubagent || session.metadata?.is_subagent === true;
    const parentComposerId = fields.parentComposerId ?? asString(session.metadata?.parent_composer_id);

    let bubbleRows: Array<Record<string, unknown>> = [];
    let truncated = false;
    try {
      bubbleRows = db
        .prepare('SELECT rowid, key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY rowid LIMIT ?')
        .all(`bubbleId:${composerId}:%`, MAX_BUBBLES_PER_COMPOSER + 1) as Array<Record<string, unknown>>;
      if (bubbleRows.length > MAX_BUBBLES_PER_COMPOSER) {
        bubbleRows = bubbleRows.slice(0, MAX_BUBBLES_PER_COMPOSER);
        truncated = true;
        issues.push({ line: 0, reason: `composer has more than ${MAX_BUBBLES_PER_COMPOSER} bubbles; tail not processed` });
      }
    } catch (error) {
      issues.push({ line: 0, reason: `bubble query failed: ${(error as Error).message}` });
      truncated = true;
    }

    const rowById = new Map<string, Record<string, unknown>>();
    for (const bubble of bubbleRows) rowById.set(bubbleIdFromKey(String(bubble.key), composerId), bubble);

    const order: string[] = [...fields.headers];
    for (const id of rowById.keys()) if (!order.includes(id)) order.push(id);
    if (fields.conversationMap) {
      for (const id of Object.keys(fields.conversationMap)) if (!order.includes(id)) order.push(id);
    }
    const missingIds = fields.headers.filter((id) => !rowById.has(id) && !(fields.conversationMap && id in fields.conversationMap));

    const records: ParseResult['records'] = [];
    let sequence = 0;
    const projectEvidence = session.project_evidence;
    const base = {
      evidence_level: 'verified' as const,
      capture_level: 'observed' as const,
      project_evidence: projectEvidence,
    };

    records.push({
      ...base,
      source_record_id: `composerHeaders:${composerId}`,
      native_event_id: `${composerId}:session:start`,
      sequence: sequence++,
      event_type: 'agent.session.started',
      occurred_at: createdAt,
      timestamp_precision: createdAt ? 'millisecond' : 'unknown',
      content: fields.name ?? composerId,
      model: fields.model,
      raw_type: 'composerData',
      capture_level: 'derived',
      metadata: {
        cursor_composer_id: composerId,
        workspace_id: fields.workspaceId ?? asString(session.metadata?.workspace_id),
        is_subagent: isSubagent,
        parent_composer_id: parentComposerId,
        ...(parentComposerId ? { parent_uuid: `${parentComposerId}:session:start` } : {}),
      },
    });

    let messageCount = 0;
    let userCount = 0;
    let assistantCount = 0;
    let toolCalls = 0;
    let thinkingBlocks = 0;
    let codeRefs = 0;
    let missing = 0;
    let unparsable = 0;
    let empty = 0;

    for (const bubbleId of order) {
      const bubble = rowById.get(bubbleId);
      let node: Record<string, unknown> | undefined;
      if (bubble) {
        const parsed = parseJsonValue(bubble.value);
        if (parsed === undefined) {
          unparsable += 1;
          issues.push({ line: 0, reason: `bubbleId:${composerId}:${bubbleId} is not valid JSON` });
          continue;
        }
        node = findMessageNode(parsed);
      } else if (fields.conversationMap && bubbleId in fields.conversationMap) {
        node = findMessageNode(fields.conversationMap[bubbleId]);
      } else {
        missing += 1;
        continue;
      }
      if (!node) {
        empty += 1;
        issues.push({ line: 0, reason: `bubbleId:${composerId}:${bubbleId} has no readable message body` });
        continue;
      }

      const type = bubbleTypeOf(node);
      const text = textOf(node.text ?? node.richText);
      const thinking = (() => {
        const raw = node.thinking;
        if (!raw) return '';
        if (typeof raw === 'string') return raw;
        const record = asRecord(raw);
        return record ? textOf(record.text ?? record.rawText ?? record) : '';
      })();
      const tool = asRecord(node.toolFormerData);
      const refs = codeBlockRefs(node);
      const timestamp = toIso(node.createdAt ?? node.timestamp ?? asRecord(node.timingInfo)?.clientStartTime);
      const precision = timestamp ? 'millisecond' : 'unknown';
      const role = type === 1 ? 'user' : type === 2 ? 'assistant' : 'unknown';
      const bubbleMeta = {
        cursor_composer_id: composerId,
        cursor_bubble_id: bubbleId,
        cursor_bubble_type: type,
        cursor_key: `bubbleId:${composerId}:${bubbleId}`,
        ...(refs.length > 0 ? { context_refs: refs } : {}),
      };

      if (thinking) {
        records.push({
          ...base,
          source_record_id: `bubbleId:${composerId}:${bubbleId}:thinking`,
          native_event_id: `${composerId}:bubble:${bubbleId}:thinking`,
          sequence: sequence++,
          event_type: 'agent.response.received',
          occurred_at: timestamp,
          timestamp_precision: precision,
          role: 'assistant',
          content: thinking,
          raw_type: 'thinking',
          metadata: { ...bubbleMeta, thinking: true },
        });
        thinkingBlocks += 1;
        assistantCount += 1;
        messageCount += 1;
      }

      if (text.trim()) {
        records.push({
          ...base,
          source_record_id: `bubbleId:${composerId}:${bubbleId}`,
          native_event_id: `${composerId}:bubble:${bubbleId}`,
          sequence: sequence++,
          event_type: type === 1 ? 'agent.user_request.submitted' : 'agent.response.received',
          occurred_at: timestamp,
          timestamp_precision: precision,
          role,
          content: text,
          raw_type: type === 1 ? 'user' : type === 2 ? 'assistant' : 'unknown',
          metadata: bubbleMeta,
        });
        if (type === 1) userCount += 1;
        else assistantCount += 1;
        messageCount += 1;
        codeRefs += refs.length;
      }

      if (tool) {
        const toolName = asString(tool.tool) ?? asString(tool.name) ?? asString(tool.toolName) ?? 'unknown';
        const callId = asString(tool.toolCallId) ?? asString(tool.callId);
        const status = asString(tool.status) ?? asString(tool.resultStatus);
        const params = stringifyUnknown(tool.params ?? tool.parameters ?? tool.input);
        const result = stringifyUnknown(tool.result ?? tool.output ?? tool.resultText);
        records.push({
          ...base,
          source_record_id: `bubbleId:${composerId}:${bubbleId}:tool:call`,
          native_event_id: `${composerId}:bubble:${bubbleId}:tool:call`,
          sequence: sequence++,
          event_type: 'agent.tool.started',
          occurred_at: timestamp,
          timestamp_precision: precision,
          role: 'assistant',
          tool_name: toolName,
          tool_call_id: callId,
          content: params,
          raw_type: 'toolFormerData',
          metadata: { ...bubbleMeta, tool_status: status },
        });
        toolCalls += 1;
        if (result) {
          const failed = status !== undefined && /error|fail|abort|cancel/i.test(status);
          records.push({
            ...base,
            source_record_id: `bubbleId:${composerId}:${bubbleId}:tool:result`,
            native_event_id: `${composerId}:bubble:${bubbleId}:tool:result`,
            sequence: sequence++,
            event_type: failed ? 'agent.tool.failed' : 'agent.tool.completed',
            occurred_at: timestamp,
            timestamp_precision: precision,
            role: 'assistant',
            tool_name: toolName,
            tool_call_id: callId,
            execution_status: status,
            content: result,
            raw_type: 'toolFormerData.result',
          });
        }
      }
    }

    if (updatedAt) {
      records.push({
        source_record_id: `composerData:${composerId}:session:end`,
        native_event_id: `${composerId}:session:end`,
        sequence: sequence++,
        event_type: 'agent.session.ended',
        occurred_at: updatedAt,
        timestamp_precision: 'millisecond',
        evidence_level: 'agent_reported',
        capture_level: 'derived',
        project_evidence: projectEvidence,
        raw_type: 'composerData.lastUpdatedAt',
        metadata: { cursor_composer_id: composerId },
      });
    }

    return {
      records,
      issues,
      truncated,
      session_started_at: createdAt,
      session_ended_at: updatedAt,
      model: fields.model,
      native_project_id: fields.workspaceId,
      project_evidence: projectEvidence,
      // Extra bookkeeping consumed by the adapter's index (typed below).
      ...({
        cursor_composer_stats: {
          message_count: messageCount,
          user_message_count: userCount,
          assistant_message_count: assistantCount,
          tool_calls: toolCalls,
          thinking_blocks: thinkingBlocks,
          code_block_refs: codeRefs,
          missing_bubbles: missing,
          missing_bubble_ids_sample: missingIds.slice(0, 20),
          unparsable_bubbles: unparsable,
          empty_bubbles: empty,
          status: messageCount > 0 ? 'exported' : data ? 'empty' : 'header_only',
        },
      } as Record<string, unknown>),
    } as ParseResult & { cursor_composer_stats: Record<string, unknown> };
  } finally {
    db.close();
  }
}

export interface CursorSupplementalInput {
  index: CursorIndexRow[];
  databases: CursorAuditDatabase[];
  transcriptIds: ReadonlySet<string>;
}

/** Build the package files: composer index (JSONL) and reconciliation audit (JSON). */
export function buildCursorSupplemental(input: CursorSupplementalInput): SupplementalFile[] {
  const rows = [...input.index].sort((a, b) =>
    (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.composer_id.localeCompare(b.composer_id),
  );
  const composerIds = new Set(rows.map((r) => r.composer_id.toLowerCase()));
  const transcripts = [...input.transcriptIds].sort();
  const matched = transcripts.filter((id) => composerIds.has(id));
  const transcriptOnly = transcripts.filter((id) => !composerIds.has(id));

  const totals = {
    composers: rows.length,
    exported: rows.filter((r) => r.status === 'exported').length,
    empty: rows.filter((r) => r.status === 'empty').length,
    header_only: rows.filter((r) => r.status === 'header_only').length,
    pending: rows.filter((r) => r.status === 'pending').length,
    error: rows.filter((r) => r.status === 'error').length,
    subagents: rows.filter((r) => r.is_subagent).length,
    messages: rows.reduce((a, r) => a + r.message_count, 0),
    tool_calls: rows.reduce((a, r) => a + r.tool_calls, 0),
    thinking_blocks: rows.reduce((a, r) => a + r.thinking_blocks, 0),
    missing_bubbles: rows.reduce((a, r) => a + r.missing_bubbles, 0),
    artifact_bytes: rows.reduce((a, r) => a + r.artifact_bytes, 0),
    artifact_files: rows.reduce((a, r) => a + r.artifact_files, 0),
    artifact_checkpoints: rows.reduce((a, r) => a + r.artifact_checkpoints, 0),
  };

  const databases = input.databases.map((db) => ({
    ...db,
    counts: {
      ...db.counts,
      sessions_exported: rows.filter((r) => r.db_path === db.db_path && r.status === 'exported').length,
      sessions_empty: rows.filter((r) => r.db_path === db.db_path && r.status === 'empty').length,
      sessions_header_only: rows.filter((r) => r.db_path === db.db_path && r.status === 'header_only').length,
      messages: rows.filter((r) => r.db_path === db.db_path).reduce((a, r) => a + r.message_count, 0),
      tool_calls: rows.filter((r) => r.db_path === db.db_path).reduce((a, r) => a + r.tool_calls, 0),
    },
    bubbles_exported: rows.filter((r) => r.db_path === db.db_path).reduce((a, r) => a + r.bubble_rows, 0),
  }));

  const audit = {
    generated_at: new Date().toISOString(),
    reader: 'cursor-global-composer',
    notes: [
      'Composer bodies are read from cursorDiskKV and normalized; the scanner never copies raw KV payloads into the package.',
      'Missing ordered bubbles are counted per composer; they are reported, never synthesized.',
      'Desktop composer ids and agent transcript ids are independent namespaces; matches are cross-evidence, absence is not proof of loss.',
    ],
    totals,
    alignment: {
      transcript_sessions: transcripts.length,
      composer_ids: rows.length,
      composer_ids_matching_transcript: matched.length,
      composer_ids_without_transcript: rows.length - matched.length,
      transcript_sessions_without_composer: transcriptOnly.length,
      matched_sample: matched.slice(0, 20),
      transcript_only_sample: transcriptOnly.slice(0, 20),
    },
    databases,
    missing_bubbles: rows
      .filter((r) => r.missing_bubbles > 0)
      .slice(0, 50)
      .map((r) => ({
        composer_id: r.composer_id,
        total: r.missing_bubbles,
        sample: r.missing_bubble_ids_sample,
      })),
    index_rows: rows.map((r) => ({
      composer_id: r.composer_id,
      session_id: r.session_id,
      status: r.status,
      is_subagent: r.is_subagent,
      parent_composer_id: r.parent_composer_id,
      bubble_rows: r.bubble_rows,
      message_count: r.message_count,
      tool_calls: r.tool_calls,
      missing_bubbles: r.missing_bubbles,
    })),
  };

  return [
    { path: 'sources/cursor-composer-index.jsonl', format: 'jsonl', content: rows },
    { path: 'reports/cursor-audit.json', format: 'json', content: audit },
  ];
}
