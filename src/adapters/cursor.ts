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
} from './types.js';

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

export class CursorAdapter implements AgentAdapter {
  readonly id = 'cursor';
  readonly name = 'Cursor';
  readonly version = '1.0.0';

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
    const metadata = await scanJsonlSessions(source, {
      predicate: (r) => /\.(db|vscdb|sqlite|sqlite3)$/.test(r),
      nativeId: (r) => r.split('/').pop() ?? r,
      maxDepth: 3,
    });
    for (const session of metadata.sessions) {
      session.metadata = { ...session.metadata, kind: 'sqlite-metadata' };
      session.project_evidence = { metadata: { source: 'cursor-sqlite' } };
    }
    return [...jsonl.sessions, ...metadata.sessions];
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
        const content = typeof message.content === 'string' ? message.content : undefined;
        records.push({
          ...base,
          event_type: role === 'user' ? 'agent.user_request.submitted' : 'agent.response.received',
          native_event_id: sourceRecordId,
          role,
          content,
        });
        sequence += 1;
      } else if (line.type === 'turn_ended') {
        records.push({
          ...base,
          event_type: 'agent.execution.completed',
          native_event_id: sourceRecordId,
          execution_status: 'reported_turn_ended',
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
    try {
      const tables = new Set(
        safeSqliteRows(db, "SELECT name FROM sqlite_master WHERE type='table'", (m) =>
          issues.push({ line: 0, reason: `schema query failed: ${m}` }),
        ).map((r) => String(r.name)),
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
    return { records, issues, truncated: false };
  }

  async parseSession(session: SessionReference): Promise<ParseResult> {
    if (/\.(db|vscdb|sqlite|sqlite3)$/.test(path.basename(session.path))) {
      return this.parseSqlite(session);
    }
    return this.parseTranscript(session);
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
      tool_calls: 'unavailable',
      ai_request: 'unavailable',
      file_changes: 'unavailable',
      git_correlation: 'unavailable',
      formats: ['jsonl', 'sqlite'],
      verification: 'partially_verified',
      notes: [
        'Real local format observed: ~/.cursor/projects/<encoded>/agent-transcripts/<uuid>/<uuid>.jsonl.',
        'Transcript records contain no timestamp; events keep occurred_at empty and fall back to observed_at for sorting.',
        'SQLite is opened with node:sqlite readOnly + PRAGMA query_only; WAL is read in place, never copied.',
        'Only conversation_summaries and composerHeaders columns are read. scored_commits / tracked_file_content are intentionally not parsed because Git Scanner is the authoritative commit source.',
        'No tool-call records exist in the observed transcript format; tool_calls is unavailable.',
        'Database summaries are agent_reported metadata, not verified execution traces.',
      ],
    });
  }
}
