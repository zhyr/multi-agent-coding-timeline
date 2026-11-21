import { discoverSources, scanJsonlSessions, type DiscoverySpec } from './discovery.js';
import { decodeProjectPath, parseLines, parseTimestamp, readSessionText, stringifyUnknown } from './util.js';
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
 * Trae / Trae CN. Verified against local data (2026-11-21):
 *   ~/.trae/memory/projects/<encoded>/YYYYMMDD/session_memory_*.jsonl
 *   ~/.trae-cn/memory/projects/<encoded>--p2-<hash>/YYYYMMDD/session_memory_*.jsonl
 *   { actions, intent, learned, message_id, message_summary_time, outcome }
 * These are memory summaries, not execution traces. Everything derived from
 * them is marked agent_reported / inferred. Trae CN appends a workspace
 * partition suffix to the encoded project directory; it is not part of the path.
 */
const SPEC: DiscoverySpec = {
  agentId: 'trae',
  defaultDirs: ['~/.trae', '~/.trae-cn'],
  markers: ['memory', 'work', 'worktrees'],
  childNames: ['.trae', '.trae-cn', 'trae', 'Trae'],
  format: 'jsonl',
};

const CN_SUFFIX_RE = /--p\d+-[A-Za-z0-9]+$/i;

function evidenceFromPath(relative: string): ProjectEvidence {
  const parts = relative.split('/');
  const encoded = parts.length >= 3 ? parts[2]! : '';
  const projectDir = encoded.replace(CN_SUFFIX_RE, '');
  return {
    projectPathHints: projectDir ? [decodeProjectPath(projectDir)] : [],
    metadata: { encoded_project_dir: projectDir },
  };
}

export class TraeAdapter implements AgentAdapter {
  readonly id = 'trae';
  readonly name = 'Trae Work';
  readonly version = '1.1.0';

  async discoverSources(options: DiscoverOptions = {}): Promise<AgentSource[]> {
    return discoverSources(SPEC, options);
  }

  async scanSessions(source: AgentSource): Promise<SessionReference[]> {
    const result = await scanJsonlSessions(source, {
      predicate: (r) => r.startsWith('memory/projects/') && r.endsWith('.jsonl'),
      nativeId: (r) => (r.split('/').pop() ?? r).replace(/\.jsonl$/, ''),
      evidence: evidenceFromPath,
      maxDepth: 6,
    });
    return result.sessions;
  }

  async parseSession(session: SessionReference): Promise<ParseResult> {
    const { text, truncated, issues } = await readSessionText(session);
    if (!text) return { records: [], issues, truncated: true };
    const lines = parseLines<Record<string, unknown>>(text, issues);
    const records: ParseResult['records'] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      // A format change (or an unrelated JSON file) must not be turned into a
      // fabricated "completed" event: require at least one memory field.
      const looksLikeMemory =
        typeof line.message_id === 'string' ||
        typeof line.intent === 'string' ||
        typeof line.outcome === 'string' ||
        line.actions !== undefined ||
        line.learned !== undefined ||
        line.message_summary_time !== undefined;
      if (!looksLikeMemory) {
        issues.push({ line: i + 1, reason: 'unrecognized Trae memory record; no event emitted' });
        continue;
      }
      const time = parseTimestamp(line.message_summary_time);
      const intent = typeof line.intent === 'string' ? line.intent : '';
      const outcome = typeof line.outcome === 'string' ? line.outcome : '';
      const sourceRecordId =
        typeof line.message_id === 'string' ? line.message_id : `line:${i + 1}`;
      records.push({
        source_record_id: sourceRecordId,
        native_event_id: typeof line.message_id === 'string' ? line.message_id : undefined,
        sequence: i,
        event_type: 'agent.execution.completed',
        occurred_at: time.iso,
        timestamp_precision: time.precision,
        content: [intent, outcome].filter(Boolean).join(' — ') || undefined,
        execution_status: 'reported_memory_summary',
        task_status: outcome || undefined,
        evidence_level: 'agent_reported',
        capture_level: 'derived',
        raw_type: 'session_memory',
        project_evidence: session.project_evidence,
        metadata: {
          actions: stringifyUnknown(line.actions, 500),
          learned: stringifyUnknown(line.learned, 500),
        },
      });
    }
    return { records, issues, truncated, project_evidence: session.project_evidence };
  }

  getCapabilities(): AdapterCapabilities {
    return makeCapabilities({
      discovery: 'verified',
      session_listing: 'partial',
      task_status: 'partial',
      timestamps: 'partial',
      project_identity: 'partial',
      incremental_scan: 'verified',
      user_request: 'unavailable',
      ai_request: 'unavailable',
      agent_response: 'unavailable',
      tool_calls: 'unavailable',
      file_changes: 'unavailable',
      git_correlation: 'unavailable',
      formats: ['jsonl'],
      verification: 'partially_verified',
      notes: [
        'Real local format observed: ~/.trae/memory/projects/<encoded>/YYYYMMDD/session_memory_*.jsonl and ~/.trae-cn/memory/projects/<encoded>--p2-<hash>/YYYYMMDD/session_memory_*.jsonl.',
        'Records are memory summaries (intent/outcome/actions/learned), not raw conversation or tool traces.',
        'All emitted events are agent_reported; no completion is treated as verified.',
        'Encoded project directory is heuristic evidence only; the Trae CN --p2-<hash> partition suffix is stripped before decoding.',
      ],
    });
  }
}
