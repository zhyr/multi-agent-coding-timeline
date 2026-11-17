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
} from './types.js';

/**
 * Claude Code. Expected layout: ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
 * with { type: user|assistant, message:{role,content}, cwd, sessionId,
 * timestamp, uuid, parentUuid } records.
 *
 * IMPORTANT: on this machine ~/.claude contains no projects/ directory and
 * ~/.claude/sessions is empty. The format is therefore NOT locally verified.
 * The parser is exercised against synthetic fixtures only and must be
 * re-validated against real Claude Code data before claiming compatibility.
 */
const SPEC: DiscoverySpec = {
  agentId: 'claude-code',
  defaultDirs: ['~/.claude'],
  markers: ['projects', 'sessions'],
  childNames: ['.claude', 'claude', 'claude-code'],
  format: 'jsonl',
};

function nativeId(relative: string): string {
  return (relative.split('/').pop() ?? relative).replace(/\.jsonl$/, '');
}

function evidenceFromPath(relative: string): ProjectEvidence {
  const parts = relative.split('/');
  return {
    projectPathHints: parts.length >= 3 ? [decodeProjectPath(parts[1]!)] : [],
    metadata: { encoded_project_dir: parts.length >= 3 ? parts[1]! : '' },
  };
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = 'claude-code';
  readonly name = 'Claude Code';
  readonly version = '0.9.0-unverified';

  async discoverSources(options: DiscoverOptions = {}): Promise<AgentSource[]> {
    return discoverSources(SPEC, options);
  }

  async scanSessions(source: AgentSource): Promise<SessionReference[]> {
    const result = await scanJsonlSessions(source, {
      predicate: (r) => /^projects\/.*\.jsonl$/.test(r),
      nativeId,
      evidence: evidenceFromPath,
      maxDepth: 4,
    });
    return result.sessions;
  }

  async parseSession(session: SessionReference): Promise<ParseResult> {
    const { text, truncated, issues } = await readSessionText(session);
    if (!text) return { records: [], issues, truncated: true };
    const lines = parseLines<Record<string, unknown>>(text, issues);
    const records: ParseResult['records'] = [];
    let sequence = 0;
    let cwd: string | undefined;
    let started: string | undefined;
    let ended: string | undefined;
    let model: string | undefined;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      const type = typeof line.type === 'string' ? line.type : '';
      if (type !== 'user' && type !== 'assistant') continue;
      const message = line.message && typeof line.message === 'object'
        ? (line.message as Record<string, unknown>)
        : {};
      const role = typeof message.role === 'string' ? message.role : type;
      const time = parseTimestamp(line.timestamp);
      if (time.iso) {
        if (!started) started = time.iso;
        ended = time.iso;
      }
      if (typeof line.cwd === 'string') cwd = line.cwd;
      if (typeof message.model === 'string') model = message.model;
      const { text: body, nonText } = extractContent(message.content);
      const sourceRecordId = typeof line.uuid === 'string' ? line.uuid : `line:${i + 1}`;
      const base = {
        source_record_id: sourceRecordId,
        occurred_at: time.iso,
        timestamp_precision: time.precision,
        raw_type: type,
        evidence_level: 'verified' as const,
        capture_level: 'observed' as const,
        model,
        project_evidence: { cwd } as ProjectEvidence,
        sequence,
      };
      records.push({
        ...base,
        event_type: role === 'user' ? 'agent.user_request.submitted' : 'agent.response.received',
        native_event_id: sourceRecordId,
        role,
        content: body || undefined,
      });
      sequence += 1;
      for (const block of nonText) {
        if (/tool_use/i.test(block.type)) {
          records.push({
            ...base,
            event_type: 'agent.tool.started',
            native_event_id: `${sourceRecordId}:${block.id ?? 'tool'}`,
            tool_name: block.name ?? block.type,
            tool_call_id: block.id,
            content: stringifyUnknown(block.input),
            sequence: sequence++,
          });
        } else if (/tool_result/i.test(block.type)) {
          records.push({
            ...base,
            event_type: 'agent.tool.completed',
            native_event_id: `${sourceRecordId}:${block.tool_use_id ?? 'result'}`,
            tool_call_id: block.tool_use_id,
            sequence: sequence++,
          });
        }
      }
    }

    return {
      records,
      issues,
      truncated,
      session_started_at: started,
      session_ended_at: ended,
      model,
      native_project_id: cwd,
      project_evidence: { cwd, projectPathHints: session.project_evidence.projectPathHints },
    };
  }

  getCapabilities(): AdapterCapabilities {
    return makeCapabilities({
      discovery: 'partial',
      session_listing: 'partial',
      user_request: 'partial',
      agent_response: 'partial',
      tool_calls: 'partial',
      timestamps: 'partial',
      project_identity: 'partial',
      incremental_scan: 'verified',
      ai_request: 'unavailable',
      task_status: 'unavailable',
      file_changes: 'unavailable',
      git_correlation: 'unavailable',
      formats: ['jsonl'],
      verification: 'not_testable',
      notes: [
        'NOT LOCALLY VERIFIED: this machine has no ~/.claude/projects data and ~/.claude/sessions is empty.',
        'Parser follows the commonly documented Claude Code JSONL shape and is covered by synthetic fixtures only.',
        'All parsing capabilities are marked partial until real records are available for validation.',
        'Directory discovery is real; session parsing is a best-effort implementation, not a compatibility claim.',
      ],
    });
  }
}
