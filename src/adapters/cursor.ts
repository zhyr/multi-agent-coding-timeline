import path from 'node:path';
import { discoverSources, scanJsonlSessions, type DiscoverySpec } from './discovery.js';
import {
  decodeProjectPath,
  openReadOnlySqlite,
  parseLines,
  parseTimestamp,
  readSessionText,
  safeSqliteRows,
} from './util.js';
import {
  makeCapabilities,
  type AdapterCapabilities,
  type AgentAdapter,
  type AgentSource,
  type DiscoverOptions,
  type ParseResult,
  type ProjectEvidence,
  type SessionReference,
  type SupplementalFile,
} from './types.js';
import {
  buildCursorSupplemental,
  listCursorGlobalComposers,
  parseCursorComposer,
  type CursorAuditDatabase,
  type CursorIndexRow,
} from './cursor-global.js';

/**
 * Cursor. Verified against local data (2026-11-17):
 *   ~/.cursor/projects/<encoded>/agent-transcripts/<uuid>/<uuid>.jsonl
 *     { role: user|assistant, message: { content } }, plus { type: turn_ended }
 *   ~/.cursor/ai-tracking/ai-code-tracking.db  (SQLite, read-only)
 *     conversation_summaries, scored_commits, ai_code_hashes, ...
 *   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 *     ItemTable, composerHeaders, cursorDiskKV, remoteAgentHeaders
 * Transcript lines carry no timestamps; time uncertainty is preserved.
 */
const SPEC: DiscoverySpec = {
  agentId: 'cursor',
  defaultDirs: ['~/.cursor', '~/Library/Application Support/Cursor/User/globalStorage'],
  markers: ['projects', 'ai-tracking', 'state.vscdb', 'plans'],
  childNames: ['.cursor', 'cursor', 'globalStorage'],
  format: 'jsonl+sqlite',
};

function transcriptEvidence(relative: string): ProjectEvidence {
  const parts = relative.split('/');
  const encoded = parts.length >= 2 ? parts[1]! : '';
  return {
    projectPathHints: encoded ? [decodeProjectPath(encoded)] : [],
    metadata: { encoded_project_dir: encoded },
  };
}

/** A single part of Cursor's `message.content` array. */
interface CursorContentBlock {
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  id: string;
  kind: 'text' | 'tool_use';
}

/**
 * Verified against 2,524 local transcript files / 350,162 lines:
 * `message.content` is an ARRAY of `{type:'text',text}` and
 * `{type:'tool_use',name,input}` blocks. A plain string is kept only for
 * backward compatibility with older fixtures.
 */
function parseContentBlocks(
  content: unknown,
  line: number,
  issues: ParseResult['issues'],
): CursorContentBlock[] {
  if (typeof content === 'string') {
    return content ? [{ kind: 'text', text: content, id: `line:${line}:text:1` }] : [];
  }
  if (content === undefined || content === null) return [];
  if (!Array.isArray(content)) {
    issues.push({ line, reason: `unsupported message.content type: ${typeof content}` });
    return [];
  }
  const blocks: CursorContentBlock[] = [];
  for (let j = 0; j < content.length; j += 1) {
    const raw = content[j];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      issues.push({ line, reason: `invalid content block at index ${j}` });
      continue;
    }
    const block = raw as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ kind: 'text', text: block.text, id: `line:${line}:text:${j + 1}` });
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      blocks.push({
        kind: 'tool_use',
        toolName: block.name,
        toolInput: block.input,
        id: `line:${line}:tool:${j + 1}`,
      });
    } else {
      issues.push({
        line,
        reason: `unsupported content block type: ${String(block.type ?? 'unknown')} at index ${j}`,
      });
    }
  }
  return blocks;
}

/** Cursor user messages embed file references as `@path/to/file`. */
function extractContextRefs(text: string | undefined): string[] | undefined {
  if (!text) return undefined;
  const refs = new Set<string>();
  for (const match of text.matchAll(/(?:^|\s)@([^\s<>]+)/g)) {
    const ref = (match[1] ?? '').replace(/[,;:]$/, '');
    if (ref.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(ref)) refs.add(ref);
  }
  return refs.size > 0 ? [...refs] : undefined;
}

function formatToolInput(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  try {
    return typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    return String(input);
  }
}

export class CursorAdapter implements AgentAdapter {
  readonly id = 'cursor';
  readonly name = 'Cursor';
  readonly version = '1.1.0';

  /** Composer index rows keyed by `${dbPath}\u0000${composerId}`. */
  private globalIndex = new Map<string, CursorIndexRow>();
  /** Per-database audit seeds (schema, namespaces, counts). */
  private globalAudit: CursorAuditDatabase[] = [];
  /** Transcript session UUIDs observed during this scan, for composer alignment. */
  private transcriptIds = new Set<string>();
  private seenGlobalDbs = new Set<string>();

  private indexKey(dbPath: string, composerId: string): string {
    return `${dbPath}\u0000${composerId}`;
  }

  async discoverSources(options: DiscoverOptions = {}): Promise<AgentSource[]> {
    return discoverSources(SPEC, options);
  }

  async scanSessions(source: AgentSource): Promise<SessionReference[]> {
    const jsonl = await scanJsonlSessions(source, {
      predicate: (r) => r.endsWith('.jsonl') && r.includes('agent-transcripts'),
      nativeId: (r) => (r.split('/').pop() ?? r).replace(/\.jsonl$/, ''),
      evidence: transcriptEvidence,
      maxDepth: 7,
    });
    for (const session of jsonl.sessions) {
      if (session.relative_path.includes('agent-transcripts')) {
        this.transcriptIds.add(session.native_session_id.toLowerCase());
      }
    }
    const metadata = await scanJsonlSessions(source, {
      predicate: (r) => /\.(db|vscdb|sqlite|sqlite3)$/.test(r),
      nativeId: (r) => r.split('/').pop() ?? r,
      maxDepth: 3,
    });

    const composerSessions: SessionReference[] = [];
    const legacySessions: SessionReference[] = [];
    for (const session of metadata.sessions) {
      if (this.seenGlobalDbs.has(session.path)) continue;
      const listing = await listCursorGlobalComposers(
        source,
        session.path,
        session.relative_path,
        this.transcriptIds,
      );
      if (!listing.available) {
        legacySessions.push(session);
        continue;
      }
      this.seenGlobalDbs.add(session.path);
      this.globalAudit.push(listing.audit);
      composerSessions.push(...listing.sessions);
      for (const entry of listing.index) {
        this.globalIndex.set(this.indexKey(session.path, entry.composer_id), entry);
      }
    }
    for (const session of legacySessions) {
      session.metadata = { ...session.metadata, kind: 'sqlite-metadata' };
      session.project_evidence = { metadata: { source: 'cursor-sqlite' } };
    }
    return [...jsonl.sessions, ...legacySessions, ...composerSessions];
  }

  private async parseTranscript(session: SessionReference): Promise<ParseResult> {
    const { text, truncated, issues } = await readSessionText(session);
    if (!text) return { records: [], issues, truncated: true };
    const lines = parseLines<Record<string, unknown>>(text, issues);
    const records: ParseResult['records'] = [];
    let sequence = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      const role = typeof line.role === 'string' ? line.role : '';
      const message = line.message && typeof line.message === 'object'
        ? (line.message as Record<string, unknown>)
        : {};
      const sourceRecordId = `line:${i + 1}`;
      const base = {
        source_record_id: sourceRecordId,
        source_line: i + 1,
        sequence,
        raw_type: typeof line.type === 'string' ? line.type : role,
        evidence_level: 'verified' as const,
        capture_level: 'observed' as const,
        timestamp_precision: 'unknown' as const,
        project_evidence: session.project_evidence,
      };
      if (role === 'user' || role === 'assistant') {
        const blocks = parseContentBlocks(message.content, i + 1, issues);
        const text = blocks
          .filter((b) => b.kind === 'text')
          .map((b) => b.text ?? '')
          .join('\n');
        const contextRefs = role === 'user' ? extractContextRefs(text) : undefined;
        records.push({
          ...base,
          event_type: role === 'user' ? 'agent.user_request.submitted' : 'agent.response.received',
          native_event_id: sourceRecordId,
          role,
          content: text || undefined,
          ...(contextRefs ? { metadata: { context_refs: contextRefs } } : {}),
        });
        sequence += 1;
        for (const block of blocks) {
          if (block.kind !== 'tool_use') continue;
          records.push({
            ...base,
            event_type: 'agent.tool.started',
            native_event_id: block.id,
            source_record_id: block.id,
            role: 'assistant',
            tool_name: block.toolName,
            content: formatToolInput(block.toolInput),
            raw_type: 'tool_use',
            sequence: sequence++,
          });
        }
      } else if (line.type === 'turn_ended') {
        const status = typeof line.status === 'string' && line.status.trim() ? line.status : 'unknown';
        const error = typeof line.error === 'string' && line.error.trim() ? line.error : undefined;
        const failed = status === 'error' || status === 'failed' || error !== undefined;
        records.push({
          ...base,
          event_type: failed ? 'agent.execution.failed' : 'agent.execution.completed',
          native_event_id: sourceRecordId,
          execution_status: status,
          error_message: error,
          evidence_level: 'agent_reported',
          capture_level: 'reported',
          sequence: sequence++,
        });
      } else {
        issues.push({ line: i + 1, reason: `unsupported record type: ${String(line.type ?? role ?? 'unknown')}` });
      }
    }
    return { records, issues, truncated, project_evidence: session.project_evidence };
  }

  private async parseSqlite(session: SessionReference): Promise<ParseResult> {
    const issues: ParseResult['issues'] = [];
    const db = await openReadOnlySqlite(session.path);
    if (!db) {
      return {
        records: [],
        issues: [{ line: 0, reason: 'node:sqlite unavailable or database could not be opened read-only' }],
        truncated: true,
      };
    }
    const records: ParseResult['records'] = [];
    let sequence = 0;
    let unreadable = false;
    try {
      const tables = new Set(
        safeSqliteRows(db, "SELECT name FROM sqlite_master WHERE type='table'", (m) => {
          unreadable = true;
          issues.push({ line: 0, reason: `schema query failed: ${m}` });
        }).map((r) => String(r.name)),
      );

      if (tables.has('conversation_summaries')) {
        for (const row of safeSqliteRows(
          db,
          'SELECT conversationId, title, tldr, model, mode, updatedAt FROM conversation_summaries',
          (m) => issues.push({ line: 0, reason: m }),
        )) {
          const id = String(row.conversationId ?? `row:${sequence}`);
          const time = parseTimestamp(row.updatedAt);
          records.push({
            source_record_id: `summary:${id}`,
            native_event_id: id,
            sequence: sequence++,
            event_type: 'agent.execution.completed',
            occurred_at: time.iso,
            timestamp_precision: time.precision,
            execution_status: 'reported_summary',
            content: [row.title, row.tldr].filter((v) => typeof v === 'string' && v.trim()).join(' — ') || undefined,
            model: typeof row.model === 'string' ? row.model : undefined,
            evidence_level: 'agent_reported',
            capture_level: 'derived',
            raw_type: 'conversation_summaries',
          });
        }
      }
      if (tables.has('composerHeaders')) {
        for (const row of safeSqliteRows(
          db,
          'SELECT composerId, workspaceId, createdAt, lastUpdatedAt FROM composerHeaders',
          (m) => issues.push({ line: 0, reason: m }),
        )) {
          const id = String(row.composerId ?? `row:${sequence}`);
          const time = parseTimestamp(row.createdAt);
          const workspace = typeof row.workspaceId === 'string' ? row.workspaceId : undefined;
          records.push({
            source_record_id: `composer:${id}`,
            native_event_id: id,
            sequence: sequence++,
            event_type: 'agent.session.started',
            occurred_at: time.iso,
            timestamp_precision: time.precision,
            evidence_level: 'verified',
            capture_level: 'derived',
            raw_type: 'composerHeaders',
            project_evidence: workspace ? { projectPathHints: [workspace], metadata: { workspace_id: workspace } } : {},
          });
        }
      }
      if (!tables.has('conversation_summaries') && !tables.has('composerHeaders')) {
        issues.push({ line: 0, reason: 'no recognized Cursor tables; SQLite source yields no events' });
      }
    } finally {
      db.close();
    }
    return { records, issues, truncated: unreadable };
  }

  async parseSession(session: SessionReference): Promise<ParseResult> {
    if (session.metadata?.kind === 'cursor-global-composer') {
      const result = await parseCursorComposer(session);
      const dbPath = String(session.metadata?.cursor_db_path ?? '');
      const composerId = String(session.metadata?.composer_id ?? session.native_session_id);
      const entry = this.globalIndex.get(this.indexKey(dbPath, composerId));
      const stats = (result as ParseResult & {
        cursor_composer_stats?: Partial<CursorIndexRow>;
      }).cursor_composer_stats;
      if (entry && stats) {
        entry.message_count = Number(stats.message_count ?? 0);
        entry.user_message_count = Number(stats.user_message_count ?? 0);
        entry.assistant_message_count = Number(stats.assistant_message_count ?? 0);
        entry.tool_calls = Number(stats.tool_calls ?? 0);
        entry.thinking_blocks = Number(stats.thinking_blocks ?? 0);
        entry.code_block_refs = Number(stats.code_block_refs ?? 0);
        entry.missing_bubbles = Number(stats.missing_bubbles ?? 0);
        entry.missing_bubble_ids_sample = Array.isArray(stats.missing_bubble_ids_sample)
          ? (stats.missing_bubble_ids_sample as string[])
          : [];
        entry.unparsable_bubbles = Number(stats.unparsable_bubbles ?? 0);
        entry.empty_bubbles = Number(stats.empty_bubbles ?? 0);
        entry.status = (stats.status as CursorIndexRow['status']) ?? entry.status;
      }
      if (entry) entry.transcript_match = this.transcriptIds.has(composerId.toLowerCase());
      return result;
    }
    if (/\.(db|vscdb|sqlite|sqlite3)$/.test(path.basename(session.path))) {
      return this.parseSqlite(session);
    }
    return this.parseTranscript(session);
  }

  supplementalFiles(): SupplementalFile[] {
    if (this.globalAudit.length === 0) return [];
    const index = [...this.globalIndex.values()];
    for (const row of index) {
      row.transcript_match = this.transcriptIds.has(row.composer_id.toLowerCase());
    }
    return buildCursorSupplemental({
      index,
      databases: this.globalAudit,
      transcriptIds: this.transcriptIds,
    });
  }

  getCapabilities(): AdapterCapabilities {
    return makeCapabilities({
      discovery: 'verified',
      session_listing: 'verified',
      user_request: 'verified',
      agent_response: 'verified',
      timestamps: 'partial',
      project_identity: 'partial',
      task_status: 'partial',
      incremental_scan: 'verified',
      tool_calls: 'verified',
      ai_request: 'unavailable',
      file_changes: 'unavailable',
      git_correlation: 'unavailable',
      formats: ['jsonl', 'sqlite'],
      verification: 'partially_verified',
      notes: [
        'Real local format observed: ~/.cursor/projects/<encoded>/agent-transcripts/<uuid>/<uuid>.jsonl.',
        'Verified over 2,524 transcripts / 350,162 lines: message.content is an array of text and tool_use blocks; both are parsed, plain string content remains supported for older fixtures.',
        'Each tool_use block becomes a separate agent.tool.started event with tool_name and its JSON input as content; evidence remains verified because the block was read directly from the transcript.',
        'User @file references are extracted into context_refs while the original user text is preserved verbatim.',
        'Transcript records contain no timestamp; events keep occurred_at empty and fall back to observed_at for sorting.',
        'Modern desktop Composer: <userData>/globalStorage/state.vscdb is read through composerHeaders + cursorDiskKV. Each composer becomes its own session and is rebuilt in Cursor order (fullConversationHeadersOnly → conversationMap → bubbleId rows).',
        'Composer bubbles yield user/assistant text, thinking blocks, toolFormerData call/result pairs, and code-block file references. Timestamps come from the bubble/composer record and are millisecond precision.',
        'Subagent composers (task-*, subagentInfo.parentComposerId) keep parent linkage; the session index and audit are written to sources/cursor-composer-index.jsonl and reports/cursor-audit.json.',
        'agentKv blob/artifact/checkpoint payloads are inventoried (counts, bytes) and referenced by key; raw KV bytes are not copied into the package and binary artifacts are never synthesized as text.',
        'Desktop composer ids and agent transcript session ids are independent namespaces. Audit alignment reports matches; absence of a match is not proof of missing data.',
        'SQLite is opened with node:sqlite readOnly + PRAGMA query_only; WAL is read in place. Composer sessions opt out of incremental reuse because hashing the shared multi-GB DB cannot prove one composer unchanged.',
        'Only conversation_summaries and Cursor global Composer tables are read. scored_commits / tracked_file_content are intentionally not parsed because Git Scanner is the authoritative commit source.',
        'No standalone LLM request payloads exist in the observed formats; they are NOT synthesized. ai_request stays unavailable.',
        'Database summaries are agent_reported metadata, not verified execution traces.',
      ],
    });
  }
}
