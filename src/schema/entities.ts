import { z } from 'zod';
import {
  Confidence,
  ContentModeSchema,
  CorrelationKindSchema,
  DedupTierSchema,
  EvidenceLevelSchema,
  IsoTimestamp,
  MatchConfidenceSchema,
  NonEmpty,
  OperationSchema,
  ShaHex,
  obj,
} from './common.js';

/** Canonical ActivityEvent. See documentation/timeline-schema.md. */
export const ActivityEventSchema = obj({
  schema_version: NonEmpty,
  event_id: NonEmpty,
  dedup_key: NonEmpty,
  dedup_tier: DedupTierSchema,
  event_type: NonEmpty,

  project_id: NonEmpty,
  repository_id: z.string().optional(),
  device_id: NonEmpty,
  scanner_device_id: z.string().optional(),
  /**
   * Stable cross-device association id. Events that describe the same
   * underlying activity on different devices share this id but keep their own
   * event_id/device_id; observations are listed in provenance.observers.
   */
  correlation_id: z.string().optional(),

  agent: obj({
    agent_id: NonEmpty,
    agent_name: NonEmpty,
    agent_version: z.string().optional(),
    model: z.string().optional(),
    native_session_id: z.string().optional(),
    native_event_id: z.string().optional(),
  }).optional(),

  session_id: z.string().optional(),
  task_id: z.string().optional(),

  activity: obj({
    role: z.string().optional(),
    content: z.string().optional(),
    content_summary: z.string().optional(),
    content_length: z.number().int().nonnegative().optional(),
    tool_name: z.string().optional(),
    tool_call_id: z.string().optional(),
    execution_status: z.string().optional(),
    error_message: z.string().optional(),
    /** File/symbol references verbatim from the source message (e.g. Cursor `@file`). */
    context_refs: z.array(z.string()).optional(),
  }).optional(),

  git: obj({
    commit_sha: z.string().optional(),
    parent_shas: z.array(z.string()).optional(),
    branch: z.string().optional(),
    remote_url: z.string().optional(),
    changed_files: z.array(z.string()).optional(),
  }).optional(),

  time: obj({
    occurred_at: IsoTimestamp.optional(),
    observed_at: IsoTimestamp,
    source_timezone: z.string().optional(),
    timestamp_precision: z.enum(['millisecond', 'second', 'minute', 'unknown']).optional(),
    sort_basis: z.enum(['occurred_at', 'observed_at_fallback']).optional(),
  }),

  provenance: obj({
    source_type: NonEmpty,
    source_agent: z.string().optional(),
    source_path: z.string().optional(),
    source_path_identity: z.string().optional(),
    source_record_id: z.string().optional(),
    /** 1-based physical line in the original source file (line-oriented formats). */
    source_line: z.number().int().positive().optional(),
    capture_method: NonEmpty,
    capture_level: z.enum(['observed', 'derived', 'reported', 'unknown']),
    source_hash: z.string().optional(),
    confidence: Confidence.optional(),
    /**
     * Legacy pointer kept for packages written by earlier releases. New
     * packages use `paired_import_sources` below, which embeds the provenance
     * of the folded record instead of pointing at an event that is not shipped.
     */
    paired_import_event_id: z.string().optional(),
    /**
     * Al-exporter imports folded into this event. The imported events are not
     * shipped, so their source references must be carried here. A differing
     * `content_hash` is recorded as `content_diverged` rather than silently
     * discarding the parse difference.
     */
    paired_import_sources: z
      .array(
        obj({
          event_id: NonEmpty,
          dedup_key: z.string().optional(),
          capture_method: z.string().optional(),
          source_path: z.string().optional(),
          source_path_identity: z.string().optional(),
          source_record_id: z.string().optional(),
          source_line: z.number().int().positive().optional(),
          raw_payload_ref: z.string().optional(),
          source_hash: z.string().optional(),
          content_hash: z.string().optional(),
          content_diverged: z.boolean().optional(),
        }),
      )
      .optional(),
    /**
     * Every device/scanner observation that supports this event. A single
     * canonical event can be observed on several devices (native-id dedup or a
     * copied session) without losing the per-device evidence. The canonical
     * event's own device/scanner remains in device_id/scanner_device_id.
     */
    observers: z
      .array(
        obj({
          device_id: NonEmpty,
          scanner_device_id: z.string().optional(),
          source_path: z.string().optional(),
          source_path_identity: z.string().optional(),
          source_record_id: z.string().optional(),
          capture_method: z.string().optional(),
          capture_level: z.enum(['observed', 'derived', 'reported', 'unknown']).optional(),
          observed_at: z.string().optional(),
          content_hash: z.string().optional(),
          content_diverged: z.boolean().optional(),
          relation: z.enum(['same_native_id', 'content_match', 'git_object', 'copied_session']).optional(),
        }),
      )
      .optional(),
    /**
     * Import adapters only: which source field produced agent.native_event_id.
     * `message_id` enables deterministic dedup; `session_line` can also be
     * folded deterministically when both sides record `source_line` and the
     * source file; `message_index` cannot.
     */
    import_identity_source: z.enum(['message_id', 'session_line', 'message_index']).optional(),
  }),

  /** Evidence is separate from factual content: an inference is never a verified fact. */
  evidence: obj({
    level: EvidenceLevelSchema,
    basis: z.string().optional(),
    note: z.string().optional(),
  }),

  correlation: obj({
    kind: CorrelationKindSchema,
    note: z.string().optional(),
    related_event_ids: z.array(z.string()).optional(),
    match_confidence: MatchConfidenceSchema.optional(),
  }).optional(),

  parser: obj({
    adapter_id: NonEmpty,
    adapter_version: NonEmpty,
    parser_version: NonEmpty,
    schema_version: NonEmpty,
  }),

  content_hash: z.string().optional(),
  redaction_kinds: z.array(z.string()).optional(),
  raw_payload_ref: z.string().optional(),
  /** Original in-session order; used as a deterministic sort tiebreaker. */
  sequence_hint: z.number().int().nonnegative().optional(),
});

export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

export const TimelineProjectSchema = obj({
  project_id: NonEmpty,
  project_name: NonEmpty,
  canonical_remote_url: z.string().optional(),
  identity_basis: z.enum(['explicit', 'remote', 'repository', 'name']),
  identity_strong: z.boolean(),
  repositories: z.array(
    obj({
      repository_id: NonEmpty,
      remote_urls: z.array(z.string()),
      repository_identity: z.string().optional(),
    }),
  ),
  worktrees: z.array(
    obj({
      worktree_id: NonEmpty,
      repository_id: NonEmpty,
      device_id: NonEmpty,
      path: NonEmpty,
      branch: z.string().optional(),
    }),
  ),
  aliases: z.array(z.string()).optional(),
});
export type TimelineProject = z.infer<typeof TimelineProjectSchema>;

export const TimelineDeviceSchema = obj({
  device_id: NonEmpty,
  device_name: z.string().optional(),
  platform: z.string().optional(),
  hostname: z.string().optional(),
  scanner_device_id: z.string().optional(),
  first_seen_at: z.string().optional(),
  source_timezone: z.string().optional(),
  /** Devices observed only as the scanner, never as a source. */
  role: z.enum(['source', 'scanner', 'both']).optional(),
});
export type TimelineDevice = z.infer<typeof TimelineDeviceSchema>;

export const AgentIdentitySchema = obj({
  agent_id: NonEmpty,
  agent_name: NonEmpty,
  adapter_version: NonEmpty,
  capabilities: z.record(z.unknown()).optional(),
  source_format: z.string().optional(),
  verification: z.enum(['verified', 'partially_verified', 'discovery_only', 'not_implemented', 'not_testable']).optional(),
});
export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;

export const SessionRecordSchema = obj({
  session_id: NonEmpty,
  project_id: NonEmpty,
  device_id: NonEmpty,
  agent_id: NonEmpty,
  native_session_id: NonEmpty,
  source_path: NonEmpty,
  source_path_identity: NonEmpty,
  first_seen_at: z.string().optional(),
  last_seen_at: z.string().optional(),
  event_count: z.number().int().nonnegative(),
  match_confidence: MatchConfidenceSchema,
  match_basis: z.string().optional(),
  incomplete: z.boolean().optional(),
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

export const TaskRecordSchema = obj({
  task_id: NonEmpty,
  project_id: NonEmpty,
  session_id: z.string().optional(),
  device_id: NonEmpty,
  agent_id: z.string().optional(),
  title: z.string().optional(),
  status: z.string().optional(),
  /** Agent-reported status is never upgraded to verified. */
  evidence_level: EvidenceLevelSchema,
  source_record_id: z.string().optional(),
});
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

export const EventRelationSchema = obj({
  relation_id: NonEmpty,
  from_event_id: NonEmpty,
  to_event_id: NonEmpty,
  kind: CorrelationKindSchema,
  note: z.string().optional(),
  project_id: NonEmpty,
});
export type EventRelation = z.infer<typeof EventRelationSchema>;

export const GitCommitRecordSchema = obj({
  commit_sha: ShaHex,
  parent_shas: z.array(ShaHex),
  project_id: NonEmpty,
  repository_id: z.string().optional(),
  device_id: NonEmpty,
  branch: z.string().optional(),
  message: z.string().optional(),
  author_name: z.string().optional(),
  author_email: z.string().optional(),
  committer_name: z.string().optional(),
  committer_email: z.string().optional(),
  authored_at: z.string().optional(),
  committed_at: z.string().optional(),
  files_changed: z.number().int().nonnegative().optional(),
  insertions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  changed_files: z.array(z.string()).optional(),
  evidence_level: z.literal('verified'),
});
export type GitCommitRecord = z.infer<typeof GitCommitRecordSchema>;

export const GitPushRecordSchema = obj({
  push_id: NonEmpty,
  project_id: NonEmpty,
  device_id: NonEmpty,
  remote_name: z.string().optional(),
  remote_url: z.string().optional(),
  ref: z.string().optional(),
  commit_sha: ShaHex.optional(),
  evidence_level: z.enum(['verified', 'inferred', 'unknown']),
  basis: NonEmpty,
  /** Reflog timestamp when a real push entry exists; absent for inferred/unknown pushes. */
  occurred_at: z.string().optional(),
  observed_at: z.string().optional(),
});
export type GitPushRecord = z.infer<typeof GitPushRecordSchema>;

export const SourceEntrySchema = obj({
  source_id: NonEmpty,
  agent_id: NonEmpty,
  device_id: NonEmpty,
  source_path: NonEmpty,
  source_path_identity: NonEmpty,
  source_type: NonEmpty,
  size_bytes: z.number().int().nonnegative().optional(),
  modified_at: z.string().optional(),
  sha256: z.string().optional(),
  record_count: z.number().int().nonnegative().optional(),
  malformed_records: z.number().int().nonnegative().optional(),
  status: z.enum(['scanned', 'skipped_unchanged', 'partial', 'failed']),
  reason: z.string().optional(),
});
export type SourceEntry = z.infer<typeof SourceEntrySchema>;

export const ScanInputsSchema = obj({
  operation: z.literal('scan'),
  project_path: NonEmpty,
  source_root: z.string().optional(),
  source_device_id: NonEmpty,
  scanner_device_id: NonEmpty,
  explicit_source_device: z.boolean(),
  content_mode: ContentModeSchema,
  selected_agents: z.array(z.string()),
  started_at: z.string(),
  adapter_versions: z.record(z.string()),
  read_only: z.literal(true),
  notes: z.array(z.string()).optional(),
});
export type ScanInputs = z.infer<typeof ScanInputsSchema>;

export const ScanReportSchema = obj({
  operation: z.literal('scan'),
  project_id: NonEmpty,
  source_device_id: NonEmpty,
  scanner_device_id: NonEmpty,
  started_at: z.string(),
  completed_at: z.string(),
  sources_discovered: z.number().int().nonnegative(),
  sources_scanned: z.number().int().nonnegative(),
  sources_failed: z.number().int().nonnegative(),
  sources_skipped_unchanged: z.number().int().nonnegative(),
  sessions_discovered: z.number().int().nonnegative(),
  sessions_matched: z.number().int().nonnegative(),
  /** Exact/strong matches only; candidate sessions are never counted here. */
  sessions_candidate_only: z.number().int().nonnegative(),
  /** Optional additive counters: packages written by earlier releases stay valid. */
  sessions_candidates_included: z.number().int().nonnegative().optional(),
  /** Sessions whose records were reused from an unchanged prior scan. */
  sessions_reused_unchanged: z.number().int().nonnegative().optional(),
  /** Files for which a stored content fingerprint was checked (reused or rejected). */
  sources_fingerprint_checked: z.number().int().nonnegative().optional(),
  /** Files that changed mid-read; their incomplete read was discarded. */
  sources_changed_during_read: z.number().int().nonnegative().optional(),
  /** Number of raw adapter records normalized before deduplication. */
  events_extracted: z.number().int().nonnegative(),
  events_rejected: z.number().int().nonnegative(),
  git_commits: z.number().int().nonnegative(),
  git_pushes: z.number().int().nonnegative(),
  agents: z.array(z.string()),
  malformed_records: z.number().int().nonnegative(),
  redacted_records: z.number().int().nonnegative(),
  symlinks_skipped: z.number().int().nonnegative(),
  /** Subdirectories that could not be read during discovery (permission/IO). */
  inaccessible_directories: z.number().int().nonnegative().optional(),
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
  candidates: z.array(
    obj({
      session_id: z.string(),
      native_session_id: z.string(),
      agent_id: z.string(),
      basis: z.string(),
      confidence: MatchConfidenceSchema,
    }),
  ).optional(),
});
export type ScanReport = z.infer<typeof ScanReportSchema>;

export const MergeReportSchema = obj({
  operation: z.literal('merge'),
  project_id: NonEmpty,
  input_timelines: z.number().int().nonnegative(),
  source_devices: z.number().int().nonnegative(),
  input_events: z.number().int().nonnegative(),
  merged_events: z.number().int().nonnegative(),
  duplicate_events: z.number().int().nonnegative(),
  conflict_events: z.number().int().nonnegative(),
  /** Deterministic cross-device associations (native id / git object / copied session). */
  cross_device_deterministic: z.number().int().nonnegative().optional(),
  /** Content-based cross-device candidate groups; events are kept, not merged. */
  cross_device_candidates: z.number().int().nonnegative().optional(),
  /** Conflict groups that involved more than one device. */
  cross_device_conflicts: z.number().int().nonnegative().optional(),
  /** Canonical events backed by observations from more than one device. */
  cross_device_merged: z.number().int().nonnegative().optional(),
  unresolved_relations: z.number().int().nonnegative(),
  schema_warnings: z.array(z.string()),
  project_identity_status: z.enum(['matched', 'weak_identity_confirmed', 'rejected']),
  input_timeline_ids: z.array(z.string()),
  input_paths: z.array(z.string()),
  completed_at: z.string(),
  warnings: z.array(z.string()).optional(),
});
export type MergeReport = z.infer<typeof MergeReportSchema>;

export const ConflictRecordSchema = obj({
  dedup_key: NonEmpty,
  kept_event_id: NonEmpty,
  variant_event_id: NonEmpty,
  reason: NonEmpty,
  input_timeline_ids: z.array(z.string()),
});
export type ConflictRecord = z.infer<typeof ConflictRecordSchema>;

export const ManifestSchema = obj({
  format: z.literal('ai-coding-timeline'),
  format_version: NonEmpty,
  schema_version: NonEmpty,
  timeline_id: NonEmpty,
  project_id: NonEmpty,
  project_name: NonEmpty,
  created_at: IsoTimestamp,
  operation: OperationSchema,
  source_devices: z.array(NonEmpty),
  input_timelines: z.array(z.string()).optional(),
  event_count: z.number().int().nonnegative(),
  session_count: z.number().int().nonnegative(),
  agent_count: z.number().int().nonnegative(),
  git_commit_count: z.number().int().nonnegative(),
  content_mode: ContentModeSchema,
  project_identity_basis: z.enum(['explicit', 'remote', 'repository', 'name']),
  project_identity_strong: z.boolean(),
  generator: obj({ name: NonEmpty, version: NonEmpty }),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export const PACKAGE_RELATIVE_FILES = [
  'manifest.json',
  'project.json',
  'devices.json',
  'agents.json',
  'sessions.jsonl',
  'tasks.jsonl',
  'events.jsonl',
  'relations.jsonl',
  'git/commits.jsonl',
  'git/pushes.jsonl',
  'sources/source-index.jsonl',
  'sources/scan-inputs.json',
  'reports/scan-report.json',
  'reports/merge-report.json',
  'reports/conflicts.jsonl',
  'integrity/checksums.sha256',
] as const;
