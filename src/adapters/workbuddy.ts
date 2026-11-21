import { discoverSources, scanJsonlSessions, type DiscoverySpec } from './discovery.js';
import {
  decodeProjectPath,
  extractContent,
  parseLines,
  parseTimestamp,
  readSessionText,
  stringifyUnknown,
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

/**
 * WorkBuddy. Verified against local data (2026-11-21):
 *   ~/.workbuddy/projects/<encoded-cwd>/<uuid>.jsonl
 *     and nested projects/<encoded-cwd>/<uuid>/subagents/agent-<uuid>.jsonl
 *     session-meta, message(role/content), reasoning(rawContent),
 *     function_call/function_call_result(callId/status/output), ai-title,
 *     file-history-snapshot, credit-usage (millisecond timestamps, cwd).
 *   ~/.workbuddy/audit-log/YYYY-MM-DD.jsonl
 *     { id, timestamp, eventType, category, decision, sessionId, toolCallId, ... }
 * Transcripts are the conversation source. Audit logs remain a separate
 * security trail: their session ids are inferred, never treated as a native
 * session start. File-history snapshots are indexed only; file-change
 * authority stays with the Git scanner.
 */
const SPEC: DiscoverySpec = {
  agentId: 'workbuddy',
  defaultDirs: ['~/.workbuddy'],
  markers: ['projects', 'audit-log', 'sessions', 'app'],
  childNames: ['.workbuddy', 'workbuddy'],
  format: 'jsonl',
};

const TRANSCRIPT_RE = /^projects\/.*\.jsonl$/;
const AUDIT_RE = /^audit(?:-log)?\/\d{4}-\d{2}-\d{2}\.jsonl$/;
const SYSTEM_REMINDER_RE = /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi;
const USER_QUERY_RE = /<user_query>([\s\S]*?)<\/user_query>/gi;
const TOOL_FAILURE_RE = /^(failed|failure|error|denied|cancelled|canceled|rejected)$/i;

interface WorkBuddyTranscriptIndexRow {
  session_id: string;
  source_path: string;
  title?: string;
  cwd?: string;
  model?: string;
  started_at?: string;
  ended_at?: string;
  records: number;
  counts: Record<string, number>;
}

function isTranscriptPath(relative: string): boolean {
  return TRANSCRIPT_RE.test(relative);
}

function isAuditPath(relative: string): boolean {
  return AUDIT_RE.test(relative);
}

function transcriptEvidence(relative: string): ProjectEvidence {
  const parts = relative.split('/');
  const encoded = parts.length >= 2 ? parts[1]! : '';
  return {
    projectPathHints: encoded ? [decodeProjectPath(encoded)] : [],
    metadata: { encoded_project_dir: encoded },
  };
}

/** WorkBuddy wraps host instructions around the original prompt; keep the prompt body. */
function cleanUserText(text: string): string {
  let raw = text.replace(SYSTEM_REMINDER_RE, '');
  const queries = [...raw.matchAll(USER_QUERY_RE)].map((m) => (m[1] ?? '').trim()).filter(Boolean);
  if (queries.length > 0) return queries.join('\n').trim();
  raw = raw.trim();
  if (/<system-reminder\b/i.test(raw) || /^<(?:user_info|environment_context)\b/i.test(raw)) return '';
  return raw;
}

/** Reasoning records keep their text in `rawContent` (or `content`) blocks. */
function reasoningText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!Array.isArray(value)) return '';
  const parts: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const block = entry as Record<string, unknown>;
    if (block.type !== 'reasoning_text' && block.type !== 'text' && block.type !== 'output_text') continue;
    if (typeof block.text === 'string' && block.text.trim()) parts.push(block.text.trim());
  }
  return parts.join('\n').trim();
}

function modelOf(line: Record<string, unknown>): string | undefined {
  const provider = line.providerData;
  if (!provider || typeof provider !== 'object') return undefined;
  for (const key of ['model', 'requestModelName', 'requestModelId', 'modelName']) {
    const value = (provider as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export class WorkBuddyAdapter implements AgentAdapter {
  readonly id = 'workbuddy';
  readonly name = 'WorkBuddy';
  readonly version = '1.1.0';

  /** Transcript index rows keyed by session id; written to sources/workbuddy-sessions.jsonl. */
  private transcriptIndex = new Map<string, WorkBuddyTranscriptIndexRow>();

  async discoverSources(options: DiscoverOptions = {}): Promise<AgentSource[]> {
    return discoverSources(SPEC, options);
  }

  async scanSessions(source: AgentSource): Promise<SessionReference[]> {
    const result = await scanJsonlSessions(source, {
      predicate: (r) => isTranscriptPath(r) || isAuditPath(r),
      nativeId: (r) => (r.split('/').pop() ?? r).replace(/\.jsonl$/, ''),
      evidence: (r) => (isTranscriptPath(r) ? transcriptEvidence(r) : {}),
      maxDepth: 6,
    });
    for (const session of result.sessions) {
      session.metadata = {
        ...session.metadata,
        kind: isTranscriptPath(session.relative_path) ? 'workbuddy-transcript' : 'workbuddy-audit',
      };
    }
    return result.sessions;
  }

  async parseSession(session: SessionReference): Promise<ParseResult> {
    const kind = session.metadata?.kind;
    if (kind === 'workbuddy-audit' || (kind !== 'workbuddy-transcript' && isAuditPath(session.relative_path))) {
      return this.parseAudit(session);
    }
    if (kind === 'workbuddy-transcript' || isTranscriptPath(session.relative_path)) {
      return this.parseTranscript(session);
    }
    // Unknown WorkBuddy layout: fail closed instead of guessing a format.
    return {
      records: [],
      issues: [{ line: 0, reason: `unrecognized WorkBuddy layout: ${session.relative_path}` }],
      truncated: false,
    };
  }

  private async parseTranscript(session: SessionReference): Promise<ParseResult> {
    const { text, truncated, issues } = await readSessionText(session);
    if (!text) return { records: [], issues, truncated: true };
    const lines = parseLines<Record<string, unknown>>(text, issues);
    const records: ParseResult['records'] = [];
    const counts: Record<string, number> = {};
    let sequence = 0;
    let cwd: string | undefined;
    let title: string | undefined;
    let model: string | undefined;
    let started: string | undefined;
    let ended: string | undefined;
    let nativeSessionId: string | undefined;

    const bump = (key: string) => {
      counts[key] = (counts[key] ?? 0) + 1;
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      const type = typeof line.type === 'string' ? line.type : '';
      const time = parseTimestamp(line.timestamp);
      if (time.iso) {
        if (!started) started = time.iso;
        ended = time.iso;
      }
      if (typeof line.cwd === 'string' && line.cwd.trim()) cwd = line.cwd.trim();
      if (typeof line.sessionId === 'string' && line.sessionId.trim()) nativeSessionId = line.sessionId.trim();
      const lineModel = modelOf(line);
      if (lineModel) model = lineModel;
      const sourceRecordId =
        typeof line.id === 'string' && line.id ? line.id : `line:${i + 1}`;
      const evidence: ProjectEvidence = cwd ? { cwd } : session.project_evidence;
      const base = {
        source_record_id: sourceRecordId,
        source_line: i + 1,
        occurred_at: time.iso,
        timestamp_precision: time.precision,
        raw_type: type || 'unknown',
        evidence_level: 'verified' as const,
        capture_level: 'observed' as const,
        project_evidence: evidence,
        model,
        sequence,
      };

      if (type === 'session-meta') {
        bump('session-meta');
        records.push({
          ...base,
          event_type: 'agent.session.started',
          native_event_id: sourceRecordId,
          sequence: sequence++,
        });
        continue;
      }

      if (type === 'ai-title') {
        bump('ai-title');
        if (typeof line.aiTitle === 'string' && line.aiTitle.trim()) title = line.aiTitle.trim();
        continue;
      }

      if (type === 'reasoning') {
        bump('reasoning');
        const body = reasoningText(line.rawContent) || reasoningText(line.content);
        if (!body) continue;
        records.push({
          ...base,
          event_type: 'agent.message.recorded',
          native_event_id: sourceRecordId,
          role: 'assistant',
          content: body,
          sequence: sequence++,
        });
        continue;
      }

      if (type === 'function_call') {
        bump('function_call');
        const name = typeof line.name === 'string' && line.name.trim() ? line.name.trim() : undefined;
        if (!name) {
          issues.push({ line: i + 1, reason: 'WorkBuddy function_call without a tool name; no event emitted' });
          continue;
        }
        records.push({
          ...base,
          event_type: 'agent.tool.started',
          native_event_id: sourceRecordId,
          role: 'assistant',
          tool_name: name,
          tool_call_id: typeof line.callId === 'string' ? line.callId : undefined,
          content: stringifyUnknown(line.arguments),
          sequence: sequence++,
        });
        continue;
      }

      if (type === 'function_call_result') {
        bump('function_call_result');
        const status = typeof line.status === 'string' && line.status.trim() ? line.status.trim() : undefined;
        const failed = status !== undefined && TOOL_FAILURE_RE.test(status);
        records.push({
          ...base,
          event_type: failed ? 'agent.tool.failed' : 'agent.tool.completed',
          native_event_id: sourceRecordId,
          tool_name: typeof line.name === 'string' ? line.name : undefined,
          tool_call_id: typeof line.callId === 'string' ? line.callId : undefined,
          execution_status: status,
          content: stringifyUnknown(line.output),
          sequence: sequence++,
        });
        continue;
      }

      if (type === 'message') {
        bump('message');
        const role = typeof line.role === 'string' ? line.role : 'unknown';
        const { text: body } = extractContent(line.content);
        const cleaned = role === 'user' ? cleanUserText(body) : body;
        if (!cleaned) continue;
        const eventType = role === 'user'
          ? 'agent.user_request.submitted'
          : role === 'assistant'
            ? 'agent.response.received'
            : 'agent.message.recorded';
        records.push({
          ...base,
          event_type: eventType,
          native_event_id: sourceRecordId,
          role,
          content: cleaned,
          sequence: sequence++,
        });
        continue;
      }

      if (type === 'file-history-snapshot') {
        // Indexed in the session summary only. Converting the snapshot into a
        // file-change event would compete with the Git scanner's authority.
        bump('file-history-snapshot');
        continue;
      }

      if (type === 'credit-usage') {
        bump('credit-usage');
        continue;
      }

      issues.push({
        line: i + 1,
        reason: `unrecognized WorkBuddy transcript record type: ${type || 'missing type'}`,
      });
    }

    const sessionId = nativeSessionId ?? session.native_session_id;
    if (records.length > 0 || Object.keys(counts).length > 0) {
      this.transcriptIndex.set(sessionId, {
        session_id: sessionId,
        source_path: session.relative_path,
        ...(title ? { title } : {}),
        ...(cwd ? { cwd } : {}),
        ...(model ? { model } : {}),
        ...(started ? { started_at: started } : {}),
        ...(ended ? { ended_at: ended } : {}),
        records: records.length,
        counts,
      });
    }

    return {
      records,
      issues,
      truncated,
      session_started_at: started,
      session_ended_at: ended,
      model,
      native_project_id: cwd,
      project_evidence: {
        ...(cwd ? { cwd } : {}),
        projectPathHints: session.project_evidence.projectPathHints,
      },
    };
  }

  private async parseAudit(session: SessionReference): Promise<ParseResult> {
    const { text, truncated, issues } = await readSessionText(session);
    if (!text) return { records: [], issues, truncated: true };
    const lines = parseLines<Record<string, unknown>>(text, issues);
    const records: ParseResult['records'] = [];
    const seenSessions = new Set<string>();
    let sequence = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      const time = parseTimestamp(line.timestamp);
      const eventType = typeof line.eventType === 'string' ? line.eventType : 'unknown';
      const category = typeof line.category === 'string' ? line.category : 'unknown';
      const decision = typeof line.decision === 'string' ? line.decision : 'unknown';
      const sessionId = typeof line.sessionId === 'string' ? line.sessionId : session.native_session_id;
      const params = line.messageParams && typeof line.messageParams === 'object'
        ? (line.messageParams as Record<string, unknown>)
        : {};
      const paths = Array.isArray(params.paths) ? params.paths.filter((p): p is string => typeof p === 'string') : [];
      const evidence: ProjectEvidence = paths.length ? { projectPathHints: paths } : {};
      const sourceRecordId = typeof line.id === 'string' ? line.id : `line:${i + 1}`;

      if (!seenSessions.has(sessionId)) {
        seenSessions.add(sessionId);
        records.push({
          source_record_id: `session:${sessionId}`,
          native_event_id: `session:${sessionId}`,
          sequence: sequence++,
          event_type: 'agent.session.started',
          occurred_at: time.iso,
          timestamp_precision: time.precision,
          evidence_level: 'inferred',
          capture_level: 'derived',
          raw_type: 'audit-session-inferred',
          project_evidence: evidence,
          metadata: { reason: 'session id first observed in audit log; no native session-start record exists' },
        });
      }

      records.push({
        source_record_id: sourceRecordId,
        native_event_id: typeof line.id === 'string' ? line.id : undefined,
        sequence: sequence++,
        event_type: 'agent.audit.recorded',
        occurred_at: time.iso,
        timestamp_precision: time.precision,
        role: 'system',
        content: [eventType, decision].join(' '),
        tool_call_id: typeof line.toolCallId === 'string' ? line.toolCallId : undefined,
        execution_status: decision,
        evidence_level: 'verified',
        capture_level: 'observed',
        raw_type: `${category}/${eventType}`,
        project_evidence: evidence,
        metadata: {
          category,
          message_key: typeof line.messageKey === 'string' ? line.messageKey : undefined,
          request_id: typeof line.requestId === 'string' ? line.requestId : undefined,
          audit_sequence: typeof line.sequence === 'number' ? line.sequence : undefined,
          params: stringifyUnknown(params, 500),
        },
      });
    }
    return { records, issues, truncated };
  }

  supplementalFiles(): SupplementalFile[] {
    if (this.transcriptIndex.size === 0) return [];
    return [
      {
        path: 'sources/workbuddy-sessions.jsonl',
        format: 'jsonl',
        content: [...this.transcriptIndex.values()].sort((a, b) =>
          a.session_id.localeCompare(b.session_id),
        ),
      },
    ];
  }

  getCapabilities(): AdapterCapabilities {
    return makeCapabilities({
      discovery: 'verified',
      session_listing: 'verified',
      user_request: 'verified',
      agent_response: 'verified',
      tool_calls: 'verified',
      timestamps: 'verified',
      project_identity: 'partial',
      incremental_scan: 'verified',
      ai_request: 'unavailable',
      task_status: 'unavailable',
      file_changes: 'unavailable',
      git_correlation: 'unavailable',
      formats: ['jsonl'],
      verification: 'verified',
      notes: [
        'Real local format observed: ~/.workbuddy/projects/<encoded-cwd>/<uuid>.jsonl conversation transcripts (including nested subagents/agent-*.jsonl) with millisecond timestamps and cwd.',
        'Transcript records: session-meta, user/assistant messages, reasoning blocks, function_call/function_call_result paired by callId, ai-title and credit-usage.',
        'Reasoning blocks are preserved as agent.message.recorded (role assistant), not double-counted as agent responses.',
        'Security audit logs (audit-log/YYYY-MM-DD.jsonl) are still parsed; their session starts remain inferred because audit logs have no native session-start record.',
        'file-history-snapshot records are counted in the session index only; file-change authority remains with the Git scanner.',
        'A per-session index (title, cwd, model, time bounds, record counts) is written to sources/workbuddy-sessions.jsonl.',
        'Project identity uses the native cwd as evidence, but matching stays partial because it still depends on path resolution.',
      ],
    });
  }
}
