import { discoverSources, scanJsonlSessions, type DiscoverySpec } from './discovery.js';
import {
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
} from './types.js';

/**
 * OpenAI Codex. Verified against local data (2026-11-17):
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]
 *   line = { ordinal, timestamp, type, payload }
 *   session_meta.payload = { id, session_id, cwd, cli_version, model_provider, ... }
 *   response_item.payload = { type, role, content }
 *   event_msg.payload     = { type, message, turn_id, ... }
 * Archived sessions are zstd-compressed; Node 22 decompresses them in memory.
 */
const SPEC: DiscoverySpec = {
  agentId: 'codex',
  defaultDirs: ['~/.codex'],
  markers: ['sessions', 'history.jsonl', 'archived_sessions', 'session_index.jsonl'],
  childNames: ['.codex', 'codex'],
  format: 'jsonl+zstd',
};

function nativeId(relative: string): string {
  const base = relative.split('/').pop() ?? relative;
  const match = /rollout-(.+?)\.jsonl(?:\.zst)?$/.exec(base);
  return match?.[1] ?? base.replace(/\.jsonl(?:\.zst)?$/, '');
}

function payloadOf(record: Record<string, unknown>): Record<string, unknown> {
  const p = record.payload;
  return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
}

const ENVIRONMENT_CONTEXT = /<environment_context>[\s\S]*?<\/environment_context>/gi;
// Codex injects repository guidance as an `# AGENTS.md instructions for <path>`
// header followed by a paired `<INSTRUCTIONS>...</INSTRUCTIONS>` block. It is
// harness metadata, never a user request.
const AGENTS_INSTRUCTIONS =
  /(?:^|\n)#\s*AGENTS\.md instructions for[^\n]*\n?[\s\S]*?<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/gi;
const INSTRUCTIONS_BLOCK = /<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/gi;
// IDE context is injected as a single `input_text` block beginning with
// `# Context from my IDE setup:`; the real user text follows a stable
// `## My request for Codex:` separator (observed 161/161 in local corpora).
const IDE_CONTEXT_HEADER = /^\s*#\s*Context from my IDE setup:/i;
const CODEX_REQUEST_SEPARATOR = /##\s*My request for Codex:\s*/i;

/**
 * Strip Codex/IDE harness metadata from a user turn so that only the real
 * request becomes an event body. Handles three observed injections:
 *   1. `<environment_context>...</environment_context>` (cwd/env metadata)
 *   2. `# AGENTS.md instructions ... <INSTRUCTIONS>...</INSTRUCTIONS>`
 *   3. `# Context from my IDE setup: ... ## My request for Codex: <real text>`
 * For (3) the injected context is dropped but the genuine request after the
 * separator is preserved, so no user content is lost.
 */
function stripEnvironmentContext(text: string): string {
  let out = text;

  // IDE context block: keep only the request after the separator if present.
  if (IDE_CONTEXT_HEADER.test(out)) {
    const sep = CODEX_REQUEST_SEPARATOR.exec(out);
    out = sep ? out.slice(sep.index + sep[0].length) : '';
  }

  out = out
    .replace(AGENTS_INSTRUCTIONS, '')
    .replace(INSTRUCTIONS_BLOCK, '')
    .replace(ENVIRONMENT_CONTEXT, '');
  return out.trim();
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly name = 'OpenAI Codex';
  readonly version = '1.0.0';

  async discoverSources(options: DiscoverOptions = {}): Promise<AgentSource[]> {
    return discoverSources(SPEC, options);
  }

  async scanSessions(source: AgentSource): Promise<SessionReference[]> {
    const result = await scanJsonlSessions(source, {
      predicate: (r) => /^sessions\/.*rollout-.*\.jsonl(?:\.zst)?$/.test(r) || /^archived_sessions\/.*\.jsonl\.zst$/.test(r),
      nativeId,
      maxDepth: 7,
    });
    for (const session of result.sessions) {
      session.metadata = {
        ...session.metadata,
        skipped_symlinks: result.skippedSymlinks,
        inaccessible: result.inaccessible.length,
      };
    }
    return result.sessions;
  }

  async parseSession(session: SessionReference): Promise<ParseResult> {
    const { text, truncated, issues } = await readSessionText(session);
    if (!text) return { records: [], issues, truncated: true };
    const lines = parseLines<Record<string, unknown>>(text, issues);
    const records: ParseResult['records'] = [];
    let sequence = 0;
    let cwd: string | undefined;
    let model: string | undefined;
    let agentVersion: string | undefined;
    let started: string | undefined;
    let ended: string | undefined;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      const payload = payloadOf(line);
      const type = typeof line.type === 'string' ? line.type : '';
      const payloadType = typeof payload.type === 'string' ? payload.type : '';
      const time = parseTimestamp(line.timestamp ?? payload.timestamp);
      const at = time.iso;
      const sourceRecordId =
        typeof line.ordinal === 'number' ? String(line.ordinal) : `line:${i + 1}`;
      const base = {
        source_record_id: sourceRecordId,
        source_line: i + 1,
        sequence: sequence,
        occurred_at: at,
        timestamp_precision: time.precision,
        raw_type: `${type}:${payloadType}`,
        evidence_level: 'verified' as const,
        capture_level: 'observed' as const,
        model,
      };

      if (type === 'session_meta') {
        if (typeof payload.cwd === 'string') cwd = payload.cwd;
        if (typeof payload.cli_version === 'string') agentVersion = payload.cli_version;
        const stamp = parseTimestamp(payload.timestamp ?? line.timestamp);
        started = stamp.iso ?? at;
        records.push({
          ...base,
          event_type: 'agent.session.started',
          native_event_id: sourceRecordId,
          content: `Codex session ${session.native_session_id}`,
          metadata: { cwd, cli_version: agentVersion, model_provider: payload.model_provider },
        });
        sequence += 1;
        continue;
      }

      if (type === 'turn_context') {
        if (typeof payload.cwd === 'string') cwd = payload.cwd;
        if (typeof payload.model === 'string') model = payload.model;
        continue;
      }

      if (type === 'response_item') {
        const role = typeof payload.role === 'string' ? payload.role : '';
        const extracted = extractContent(payload.content);
        const isUser = role === 'user';
        const isAssistant = role === 'assistant';
        const body = isUser ? stripEnvironmentContext(extracted.text) : extracted.text;
        if ((isUser || isAssistant) && body) {
          records.push({
            ...base,
            event_type: isUser ? 'agent.user_request.submitted' : 'agent.response.received',
            native_event_id: sourceRecordId,
            role,
            content: body,
            model: typeof payload.model === 'string' ? payload.model : model,
          });
          sequence += 1;
        }
        for (const block of extracted.nonText) {
          if (/function_call|tool_use|computer_call/i.test(block.type)) {
            records.push({
              ...base,
              event_type: 'agent.tool.started',
              native_event_id: `${sourceRecordId}:${block.type}`,
              tool_name: block.name ?? block.type,
              tool_call_id: block.id,
              content: stringifyUnknown(block.input),
            });
            sequence += 1;
          } else if (/function_call_output|tool_result/i.test(block.type)) {
            records.push({
              ...base,
              event_type: 'agent.tool.completed',
              native_event_id: `${sourceRecordId}:${block.type}`,
              tool_call_id: block.tool_use_id ?? block.id,
              content: stringifyUnknown(block.content),
            });
            sequence += 1;
          }
        }
        continue;
      }

      if (type === 'event_msg') {
        // Status messages are agent statements, not verified execution facts.
        if (/task_complete|turn_complete|agent_message_complete/i.test(payloadType)) {
          records.push({
            ...base,
            event_type: 'agent.execution.completed',
            native_event_id: sourceRecordId,
            execution_status: 'reported_complete',
            evidence_level: 'agent_reported',
            capture_level: 'reported',
            content: typeof payload.message === 'string' ? payload.message : undefined,
          });
          sequence += 1;
        } else if (/task_started|turn_started/i.test(payloadType)) {
          records.push({
            ...base,
            event_type: 'agent.execution.started',
            native_event_id: sourceRecordId,
            execution_status: 'reported_started',
            evidence_level: 'agent_reported',
            capture_level: 'reported',
          });
          sequence += 1;
        } else if (/error|aborted|failed/i.test(payloadType)) {
          records.push({
            ...base,
            event_type: 'agent.execution.failed',
            native_event_id: sourceRecordId,
            execution_status: 'reported_failed',
            evidence_level: 'agent_reported',
            capture_level: 'reported',
            error_message: typeof payload.message === 'string' ? payload.message : payloadType,
          });
          sequence += 1;
        }
        if (at) ended = at;
      }
    }

    const evidence: ProjectEvidence = { cwd };
    return {
      records,
      issues,
      truncated,
      session_started_at: started,
      session_ended_at: ended,
      model,
      project_evidence: evidence,
      native_project_id: cwd,
    };
  }

  getCapabilities(): AdapterCapabilities {
    return makeCapabilities({
      discovery: 'verified',
      session_listing: 'verified',
      user_request: 'verified',
      agent_response: 'verified',
      tool_calls: 'partial',
      task_status: 'partial',
      project_identity: 'partial',
      timestamps: 'verified',
      incremental_scan: 'verified',
      ai_request: 'unavailable',
      file_changes: 'unavailable',
      git_correlation: 'unavailable',
      formats: ['jsonl', 'jsonl.zst'],
      verification: 'verified',
      notes: [
        'Real local format observed: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.zst (214 archives inspected structurally).',
        'response_item.content uses input_text/output_text blocks; input_image and encrypted_content are non-text.',
        'session_meta.payload.cwd is a path signal only: a cwd inside the worktree is strong, an ancestor cwd is candidate.',
        'task_complete is stored as agent_reported, never as a verified execution fact.',
        'Raw model request bodies are not present in rollout files; ai_request is unavailable.',
        'history.jsonl / session_index.jsonl are indexes, not parsed to avoid duplicate events.',
      ],
    });
  }
}
