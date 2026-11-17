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
 * Qoder. Verified against local data (2026-11-17):
 *   ~/.qoder/projects/<encoded-cwd>/<uuid>.jsonl
 *   types: workspace-directories | runtime-config | user | assistant |
 *          attachment | active-leaf | last-prompt | file-history-snapshot | system
 *   user/assistant records carry cwd, gitBranch, timestamp, uuid, parentUuid,
 *   sessionId and message:{role,content,model}; assistant content contains
 *   text / tool_use / tool_result blocks.
 */
const SPEC: DiscoverySpec = {
  agentId: 'qoder',
  defaultDirs: ['~/.qoder'],
  markers: ['projects'],
  childNames: ['.qoder', 'qoder'],
  format: 'jsonl',
};

function nativeId(relative: string): string {
  return (relative.split('/').pop() ?? relative).replace(/\.jsonl$/, '');
}

function evidenceFromPath(relative: string): ProjectEvidence {
  const parts = relative.split('/');
  const encoded = parts.length >= 3 ? parts[1]! : '';
  const hints = encoded ? [decodeProjectPath(encoded)] : [];
  return { projectPathHints: hints, metadata: { encoded_project_dir: encoded } };
}

export class QoderAdapter implements AgentAdapter {
  readonly id = 'qoder';
  readonly name = 'Qoder';
  readonly version = '1.0.0';

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
    let gitBranch: string | undefined;
    let model: string | undefined;
    let started: string | undefined;
    let ended: string | undefined;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      const type = typeof line.type === 'string' ? line.type : '';
      const time = parseTimestamp(line.timestamp);
      const at = time.iso;
      const sourceRecordId =
        typeof line.uuid === 'string' ? line.uuid : `line:${i + 1}`;
      const recordCwd = typeof line.cwd === 'string' ? line.cwd : undefined;
      if (recordCwd) cwd = recordCwd;
      if (typeof line.gitBranch === 'string') gitBranch = line.gitBranch;
      if (at) {
        if (!started) started = at;
        ended = at;
      }
      const message = line.message && typeof line.message === 'object'
        ? (line.message as Record<string, unknown>)
        : {};
      const base = {
        source_record_id: sourceRecordId,
        source_line: i + 1,
        sequence,
        occurred_at: at,
        timestamp_precision: time.precision,
        raw_type: type,
        evidence_level: 'verified' as const,
        capture_level: 'observed' as const,
        model: typeof message.model === 'string' ? message.model : model,
        branch: gitBranch,
        project_evidence: { cwd, gitBranch } as ProjectEvidence,
      };

      if (type === 'workspace-directories') {
        const dirs = Array.isArray(line.directories) ? line.directories.filter((d): d is string => typeof d === 'string') : [];
        if (dirs.length) cwd = dirs[0];
        continue;
      }
      if (type === 'runtime-config') {
        if (typeof line.model === 'string') model = line.model;
        continue;
      }
      if (type === 'file-history-snapshot' || type === 'active-leaf' || type === 'last-prompt') continue;
      if (type === 'system' || type === 'attachment') continue;

      if (type === 'user' || type === 'assistant') {
        const role = typeof message.role === 'string' ? message.role : type;
        const { text: body, nonText } = extractContent(message.content);
        const humanInput = line.humanInput && typeof line.humanInput === 'object'
          ? (line.humanInput as Record<string, unknown>)
          : undefined;
        const fallback = typeof humanInput?.text === 'string' ? humanInput.text : undefined;
        records.push({
          ...base,
          event_type: role === 'user' ? 'agent.user_request.submitted' : 'agent.response.received',
          native_event_id: sourceRecordId,
          role,
          content: body || fallback || undefined,
          metadata: {
            parent_uuid: typeof line.parentUuid === 'string' ? line.parentUuid : undefined,
            is_sidechain: line.isSidechain,
            stop_reason: typeof message.stop_reason === 'string' ? message.stop_reason : undefined,
          },
        });
        sequence += 1;

        for (const block of nonText) {
          if (/tool_use|function_call/i.test(block.type)) {
            records.push({
              ...base,
              event_type: 'agent.tool.started',
              native_event_id: `${sourceRecordId}:${block.id ?? block.type}`,
              tool_name: block.name ?? block.type,
              tool_call_id: block.id,
              content: stringifyUnknown(block.input),
              sequence: sequence++,
            });
          } else if (/tool_result|function_call_output/i.test(block.type)) {
            records.push({
              ...base,
              event_type: 'agent.tool.completed',
              native_event_id: `${sourceRecordId}:${block.tool_use_id ?? block.type}`,
              tool_call_id: block.tool_use_id,
              content: stringifyUnknown(block.content),
              sequence: sequence++,
            });
          }
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
      project_evidence: {
        cwd,
        projectPathHints: session.project_evidence.projectPathHints,
        metadata: gitBranch ? { git_branch: gitBranch } : {},
      },
    };
  }

  getCapabilities(): AdapterCapabilities {
    return makeCapabilities({
      discovery: 'verified',
      session_listing: 'verified',
      user_request: 'verified',
      agent_response: 'verified',
      tool_calls: 'partial',
      timestamps: 'verified',
      project_identity: 'verified',
      incremental_scan: 'verified',
      ai_request: 'unavailable',
      task_status: 'unavailable',
      file_changes: 'unavailable',
      git_correlation: 'partial',
      formats: ['jsonl'],
      verification: 'verified',
      notes: [
        'Real local format observed: ~/.qoder/projects/<encoded-cwd>/<uuid>.jsonl.',
        'cwd, gitBranch and uuid give strong project association and native event IDs.',
        'assistant message blocks are parsed for tool_use/tool_result only; execution status is not present.',
        'file-history-snapshot records are indexed but not converted into file-change events in v1; file_changes is therefore unavailable.',
        'Encoded project directory names are heuristic path evidence, never an exact match by themselves.',
      ],
    });
  }
}
