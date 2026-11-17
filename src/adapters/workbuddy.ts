import { discoverSources, scanJsonlSessions, type DiscoverySpec } from './discovery.js';
import { parseLines, parseTimestamp, readSessionText, stringifyUnknown } from './util.js';
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
 * WorkBuddy. Verified against local data (2026-11-17):
 *   ~/.workbuddy/audit-log/YYYY-MM-DD.jsonl
 *   { id, timestamp, sequence, eventType, category, decision, source,
 *     sessionId, requestId, toolCallId, messageKey, messageParams,
 *     hash, prevHash, schemaVersion }
 * These are security/audit events, NOT conversation transcripts. This adapter
 * therefore never claims user request or agent response support.
 */
const SPEC: DiscoverySpec = {
  agentId: 'workbuddy',
  defaultDirs: ['~/.workbuddy'],
  markers: ['audit-log', 'sessions', 'app'],
  childNames: ['.workbuddy', 'workbuddy'],
  format: 'jsonl',
};

export class WorkBuddyAdapter implements AgentAdapter {
  readonly id = 'workbuddy';
  readonly name = 'WorkBuddy';
  readonly version = '1.0.0';

  async discoverSources(options: DiscoverOptions = {}): Promise<AgentSource[]> {
    return discoverSources(SPEC, options);
  }

  async scanSessions(source: AgentSource): Promise<SessionReference[]> {
    const result = await scanJsonlSessions(source, {
      predicate: (r) => /^audit-log\/\d{4}-\d{2}-\d{2}\.jsonl$/.test(r),
      nativeId: (r) => (r.split('/').pop() ?? r).replace(/\.jsonl$/, ''),
      maxDepth: 3,
    });
    return result.sessions;
  }

  async parseSession(session: SessionReference): Promise<ParseResult> {
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

  getCapabilities(): AdapterCapabilities {
    return makeCapabilities({
      discovery: 'verified',
      session_listing: 'partial',
      tool_calls: 'unavailable',
      timestamps: 'verified',
      incremental_scan: 'verified',
      user_request: 'unavailable',
      ai_request: 'unavailable',
      agent_response: 'unavailable',
      task_status: 'unavailable',
      file_changes: 'unavailable',
      project_identity: 'partial',
      git_correlation: 'unavailable',
      formats: ['jsonl'],
      verification: 'partially_verified',
      notes: [
        'Real local format observed: ~/.workbuddy/audit-log/YYYY-MM-DD.jsonl security audit records.',
        'Only audit events are produced. WorkBuddy conversation content is not present in the observed directory and is NOT parsed.',
        'toolCallId is retained as a correlation field on audit events, but no tool start/complete events exist; tool_calls is unavailable.',
        'Session start derived from first-seen sessionId is explicitly marked inferred, never verified.',
        'Project association can only come from messageParams.paths and is candidate-grade at best.',
        'edge-sync-mapping-v4.db exists but is a sync mapping table, not a session store; it is not parsed.',
      ],
    });
  }
}
