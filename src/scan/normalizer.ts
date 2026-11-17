import { SCHEMA_VERSION, type ContentMode, type MatchConfidence } from '../core/constants.js';
import { applyContentMode } from '../core/redaction.js';
import { computeContentHash, computeDedupKey, computeEventId, computeSessionId } from '../core/ids.js';
import { displayPath } from '../core/fs.js';
import type { AdapterRecord, AgentAdapter, SessionReference } from '../adapters/types.js';
import { makeCapabilities } from '../adapters/types.js';
import type { ActivityEvent } from '../schema/entities.js';

/** Read-only synthetic sources (git history, merge bookkeeping) reuse the normalizer. */
export function syntheticAdapter(id: string, name: string): AgentAdapter {
  return {
    id,
    name,
    version: '1.0.0',
    discoverSources: async () => [],
    scanSessions: async () => [],
    parseSession: async () => ({ records: [], issues: [], truncated: false }),
    getCapabilities: () =>
      makeCapabilities({
        formats: [],
        verification: 'not_implemented',
        notes: ['synthetic source used by the shared normalizer'],
      }),
  };
}

export interface NormalizeContext {
  projectId: string;
  repositoryId?: string;
  sourceDeviceId: string;
  scannerDeviceId: string;
  adapter: AgentAdapter;
  session: SessionReference;
  /** Absent for events that do not belong to an agent session (e.g. Git pushes). */
  sessionId?: string;
  contentMode: ContentMode;
  observedAt: string;
  sourceHash?: string;
  matchConfidence: MatchConfidence;
  matchBasis: string;
  sourceType?: string;
  captureMethod?: string;
}

/** Mount-point-independent source identity, namespaced by agent. */
export function buildSourcePathIdentity(adapterId: string, relativePath: string): string {
  return `${adapterId}/${relativePath}`;
}

/**
 * The single normalization entry point shared by Local Scan, Remote Scan and
 * Merge. Every event keeps its source reference, parser version and evidence
 * classification; inference metadata is never folded into factual fields.
 */
export function normalizeRecord(record: AdapterRecord, ctx: NormalizeContext): ActivityEvent {
  const fields = applyContentMode(record.content, ctx.contentMode);
  const identity = buildSourcePathIdentity(ctx.adapter.id, ctx.session.relative_path);

  const activity: ActivityEvent['activity'] = {
    role: record.role,
    content: fields.content,
    content_summary: fields.content_summary,
    content_length: fields.content_length,
    tool_name: record.tool_name,
    tool_call_id: record.tool_call_id,
    execution_status: record.execution_status,
    error_message: record.error_message,
  };
  const cleanedActivity = Object.fromEntries(
    Object.entries(activity).filter(([, v]) => v !== undefined),
  ) as ActivityEvent['activity'];

  const git =
    record.commit_sha || record.parent_shas?.length || record.branch || record.changed_files?.length
      ? {
          commit_sha: record.commit_sha,
          parent_shas: record.parent_shas,
          branch: record.branch,
          changed_files: record.changed_files,
        }
      : undefined;

  const agentId = record.agent_override?.id ?? ctx.adapter.id;
  const agentName = record.agent_override?.name ?? ctx.adapter.name;
  const agentVersion = record.agent_override?.version ?? ctx.adapter.version;

  const provenance: ActivityEvent['provenance'] = {
    source_type: ctx.sourceType ?? 'agent-session',
    source_agent: agentId,
    source_path: displayPath(ctx.session.path),
    source_path_identity: identity,
    source_record_id: record.source_record_id,
    raw_payload_ref: record.raw_payload_ref,
    capture_method: ctx.captureMethod ?? `adapter:${ctx.adapter.id}`,
    capture_level: record.capture_level,
    source_hash: ctx.sourceHash,
    confidence: ctx.matchConfidence === 'exact' ? 1 : ctx.matchConfidence === 'strong' ? 0.8 : 0.4,
  };

  const contentHash = computeContentHash({
    event_type: record.event_type,
    time: { occurred_at: record.occurred_at },
    agent: {
      agent_id: agentId,
      native_session_id: ctx.session.native_session_id,
      native_event_id: record.native_event_id,
      model: record.model,
    },
    session_id: ctx.sessionId,
    activity: cleanedActivity,
    git,
    provenance,
  });

  const dedup = computeDedupKey({
    agentId,
    nativeSessionId: ctx.session.native_session_id,
    nativeEventId: record.native_event_id,
    sourceDeviceId: ctx.sourceDeviceId,
    sourcePathIdentity: identity,
    sourceRecordId: record.source_record_id,
    sessionId: ctx.sessionId,
    eventType: record.event_type,
    occurredAt: record.occurred_at,
    contentHash,
  });

  const parentUuid = record.metadata?.parent_uuid;
  const correlation =
    ctx.matchConfidence === 'candidate'
      ? {
          kind: 'time_based_inference' as const,
          note: `candidate project association: ${ctx.matchBasis}`,
          match_confidence: ctx.matchConfidence,
          ...(typeof parentUuid === 'string' ? { related_event_ids: [parentUuid] } : {}),
        }
      : typeof parentUuid === 'string'
        ? { kind: 'explicit_reference' as const, note: 'native parent record reference', related_event_ids: [parentUuid] }
        : undefined;

  const event: ActivityEvent = {
    schema_version: SCHEMA_VERSION,
    event_id: computeEventId(dedup.dedupKey),
    dedup_key: dedup.dedupKey,
    dedup_tier: dedup.tier,
    event_type: record.event_type,
    project_id: ctx.projectId,
    repository_id: ctx.repositoryId,
    device_id: ctx.sourceDeviceId,
    scanner_device_id: ctx.scannerDeviceId,
    agent: {
      agent_id: agentId,
      agent_name: agentName,
      agent_version: agentVersion,
      model: record.model,
      native_session_id: ctx.session.native_session_id,
      native_event_id: record.native_event_id,
    },
    session_id: ctx.sessionId,
    activity: cleanedActivity,
    git,
    time: {
      occurred_at: record.occurred_at,
      observed_at: ctx.observedAt,
      timestamp_precision: record.timestamp_precision ?? 'unknown',
      sort_basis: record.occurred_at ? 'occurred_at' : 'observed_at_fallback',
    },
    provenance,
    evidence: {
      level: record.evidence_level,
      basis: record.capture_level === 'observed' ? 'original agent record' : 'derived from agent record',
      note: ctx.matchConfidence !== 'exact' ? `project match: ${ctx.matchConfidence} (${ctx.matchBasis})` : undefined,
    },
    correlation,
    parser: {
      adapter_id: ctx.adapter.id,
      adapter_version: ctx.adapter.version,
      parser_version: ctx.adapter.version,
      schema_version: SCHEMA_VERSION,
    },
    content_hash: contentHash,
    redaction_kinds: fields.redaction_kinds,
    sequence_hint: record.sequence,
  };
  return event;
}

/** Git commits are first-class verified events produced by the same normalizer. */
export function normalizeGitCommit(options: {
  commitSha: string;
  parentShas: string[];
  branch?: string;
  message?: string;
  authoredAt?: string;
  committedAt?: string;
  changedFiles?: string[];
  projectId: string;
  repositoryId?: string;
  deviceId: string;
  scannerDeviceId: string;
  observedAt: string;
  remoteUrl?: string;
}): ActivityEvent {
  const identity = buildSourcePathIdentity('git', 'refs/commits');
  const record: AdapterRecord = {
    event_type: 'git.commit.created',
    occurred_at: options.committedAt ?? options.authoredAt,
    timestamp_precision: 'second',
    content: options.message,
    commit_sha: options.commitSha,
    parent_shas: options.parentShas,
    branch: options.branch,
    changed_files: options.changedFiles,
    evidence_level: 'verified',
    capture_level: 'observed',
    source_record_id: options.commitSha,
    sequence: 0,
  };
  const fakeSession: SessionReference = {
    native_session_id: 'git-history',
    source: {
      source_id: 'git',
      agent_id: 'git',
      root: '',
      display_path: 'git-history',
      format: 'git',
      discovered_from: 'default',
      readable: true,
    },
    path: 'git-history',
    relative_path: 'refs/commits',
    size_bytes: 0,
    project_evidence: {},
  };
  const event = normalizeRecord(record, {
    projectId: options.projectId,
    repositoryId: options.repositoryId,
    sourceDeviceId: options.deviceId,
    scannerDeviceId: options.scannerDeviceId,
    adapter: syntheticAdapter('git', 'Git'),
    session: fakeSession,
    sessionId: 'git-history',
    contentMode: 'summary',
    observedAt: options.observedAt,
    matchConfidence: 'exact',
    matchBasis: 'git_worktree',
    sourceType: 'git-repository',
    captureMethod: 'git-log-read-only',
  });
  event.session_id = undefined;
  event.agent = undefined;
  event.provenance.source_path = 'git:HEAD';
  event.provenance.source_path_identity = identity;
  event.provenance.source_record_id = options.commitSha;
  if (event.git) event.git.remote_url = options.remoteUrl;
  // Recompute IDs after the git-specific source identity was applied.
  const contentHash = computeContentHash({
    event_type: event.event_type,
    time: event.time,
    activity: event.activity,
    git: event.git,
    provenance: event.provenance,
  });
  const dedup = computeDedupKey({
    sourceDeviceId: options.deviceId,
    sourcePathIdentity: identity,
    sourceRecordId: options.commitSha,
    eventType: event.event_type,
    occurredAt: event.time.occurred_at,
    contentHash,
  });
  event.content_hash = contentHash;
  event.dedup_key = dedup.dedupKey;
  event.dedup_tier = dedup.tier;
  event.event_id = computeEventId(dedup.dedupKey);
  return event;
}

export { computeSessionId };
