/** Format and schema version constants. See documentation/timeline-schema.md. */
export const FORMAT = 'ai-coding-timeline';
export const FORMAT_VERSION = '1.0.0';
export const SCHEMA_VERSION = '1.0.0';

/** Versions this build can read. Newer/unknown versions are rejected, never guessed. */
export const SUPPORTED_SCHEMA_VERSIONS: readonly string[] = ['1.0.0'];

export const CONTENT_MODES = ['metadata_only', 'summary', 'full'] as const;
export type ContentMode = (typeof CONTENT_MODES)[number];

export const EVIDENCE_LEVELS = ['verified', 'agent_reported', 'inferred', 'unknown'] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export const MATCH_CONFIDENCE = ['exact', 'strong', 'candidate', 'none'] as const;
export type MatchConfidence = (typeof MATCH_CONFIDENCE)[number];

export const CORRELATION_KINDS = [
  'directly_observed',
  'explicit_reference',
  'strongly_supported',
  'time_based_inference',
] as const;
export type CorrelationKind = (typeof CORRELATION_KINDS)[number];

/** Deterministic CLI exit codes. */
export const EXIT = {
  OK: 0,
  USAGE: 2,
  VALIDATION_FAILED: 4,
  SCAN_FAILED: 5,
  MERGE_FAILED: 6,
  IO_ERROR: 7,
  INTERNAL: 70,
} as const;

export const EVENT_TYPES = [
  'agent.session.started',
  'agent.session.resumed',
  'agent.session.ended',
  'agent.user_request.submitted',
  'agent.ai_request.submitted',
  'agent.response.received',
  /** Generic imported message rows (Al-exporter archives). */
  'agent.message.recorded',
  'agent.execution.started',
  'agent.execution.completed',
  'agent.execution.failed',
  'agent.tool.started',
  'agent.tool.completed',
  'agent.tool.failed',
  'agent.audit.recorded',
  'git.file.changed',
  'git.branch.changed',
  'git.commit.created',
  'git.push.completed',
  'timeline.scan.completed',
  'timeline.merge.completed',
] as const;
