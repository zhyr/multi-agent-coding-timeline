import type { EvidenceLevel } from '../core/constants.js';

export type CapabilityLevel = 'verified' | 'partial' | 'unavailable';

export type VerificationStatus =
  | 'verified'
  | 'partially_verified'
  | 'discovery_only'
  | 'not_implemented'
  | 'not_testable';

/**
 * Honest capability declaration. `verified` is used only when the format was
 * observed in this environment and exercised by tests with synthetic fixtures.
 * Directory discovery alone never counts as parsing support.
 */
export interface AdapterCapabilities {
  discovery: CapabilityLevel;
  session_listing: CapabilityLevel;
  user_request: CapabilityLevel;
  ai_request: CapabilityLevel;
  agent_response: CapabilityLevel;
  tool_calls: CapabilityLevel;
  task_status: CapabilityLevel;
  file_changes: CapabilityLevel;
  project_identity: CapabilityLevel;
  timestamps: CapabilityLevel;
  incremental_scan: CapabilityLevel;
  git_correlation: CapabilityLevel;
  formats: string[];
  verification: VerificationStatus;
  /** Per-source interop details (for example an Al-exporter interop.json capability matrix). */
  interop?: Record<string, unknown>;
  notes: string[];
}

export interface AgentSource {
  source_id: string;
  agent_id: string;
  /** Absolute root. All reads stay inside this directory. */
  root: string;
  display_path: string;
  format: string;
  discovered_from: 'default' | 'explicit-root' | 'fixture';
  readable: boolean;
  metadata?: Record<string, unknown>;
}

/** Evidence used by the Project Resolver; never a match decision by itself. */
export interface ProjectEvidence {
  cwd?: string;
  gitRemote?: string;
  nativeProjectId?: string;
  projectPathHints?: string[];
  metadata?: Record<string, string>;
}

export interface SessionReference {
  native_session_id: string;
  source: AgentSource;
  /** Absolute path of the session file. */
  path: string;
  /** Path relative to the source root; used as a mount-point-independent identity. */
  relative_path: string;
  size_bytes: number;
  modified_at?: string;
  project_evidence: ProjectEvidence;
  incomplete?: boolean;
  metadata?: Record<string, unknown>;
}

/** Device identity declared by an archive itself (for example a remote export). */
export interface DeclaredSourceDevice {
  device_id: string;
  basis?: string;
  hostname?: string;
  /** Where the declaration came from, e.g. manifest.device. */
  source: string;
}

export type CaptureLevel = 'observed' | 'derived' | 'reported' | 'unknown';
export type TimestampPrecision = 'millisecond' | 'second' | 'minute' | 'unknown';

/** Parsed, adapter-neutral record. Normalization into ActivityEvent happens once, in the shared engine. */
export interface AdapterRecord {
  native_event_id?: string;
  event_type: string;
  occurred_at?: string;
  timestamp_precision?: TimestampPrecision;
  role?: string;
  content?: string;
  tool_name?: string;
  tool_call_id?: string;
  execution_status?: string;
  error_message?: string;
  task_id?: string;
  task_title?: string;
  task_status?: string;
  model?: string;
  commit_sha?: string;
  parent_shas?: string[];
  branch?: string;
  changed_files?: string[];
  evidence_level: EvidenceLevel;
  capture_level: CaptureLevel;
  /** Stable identifier of the original line / row inside the source. */
  source_record_id: string;
  /** 1-based physical line in the original source file, when the format is line-oriented. */
  source_line?: number;
  /** Original order inside the session. */
  sequence: number;
  project_evidence?: ProjectEvidence;
  raw_type?: string;
  metadata?: Record<string, unknown>;
  /** Import adapters: attribute the event to the original agent, not the importer. */
  agent_override?: { id: string; name?: string; version?: string };
  /** Import adapters: original record behind a derived artifact (two-hop provenance). */
  raw_payload_ref?: string;
  /** Import adapters: which source field produced native_event_id. */
  import_identity_source?: 'message_id' | 'session_line' | 'message_index';
}

export interface ParseIssue {
  line: number;
  reason: string;
}

export interface ParseResult {
  records: AdapterRecord[];
  issues: ParseIssue[];
  truncated: boolean;
  session_started_at?: string;
  session_ended_at?: string;
  model?: string;
  native_project_id?: string;
  project_evidence?: ProjectEvidence;
}

export interface DiscoverOptions {
  roots?: string[];
}

/**
 * Stable adapter contract. `parseSession` returns a ParseResult rather than a
 * bare array so malformed/truncated records are reported, never silently
 * dropped. Returned records are adapter-neutral but NOT yet normalized; the
 * single shared Timeline Normalizer assigns project/device identity and IDs.
 */
export interface AgentAdapter {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  discoverSources(options?: DiscoverOptions): Promise<AgentSource[]>;
  scanSessions(source: AgentSource): Promise<SessionReference[]>;
  parseSession(session: SessionReference): Promise<ParseResult>;
  getCapabilities(): AdapterCapabilities;
  /**
   * Optional archive-level device declaration. Used only when discovery was
   * explicit; the engine decides how it interacts with --source-device.
   */
  declaredSourceDevice?(source: AgentSource): Promise<DeclaredSourceDevice | undefined>;
}

export function makeCapabilities(
  partial: Partial<AdapterCapabilities> & Pick<AdapterCapabilities, 'formats' | 'verification' | 'notes'>,
): AdapterCapabilities {
  return {
    discovery: 'unavailable',
    session_listing: 'unavailable',
    user_request: 'unavailable',
    ai_request: 'unavailable',
    agent_response: 'unavailable',
    tool_calls: 'unavailable',
    task_status: 'unavailable',
    file_changes: 'unavailable',
    project_identity: 'unavailable',
    timestamps: 'unavailable',
    incremental_scan: 'unavailable',
    git_correlation: 'unavailable',
    ...partial,
  };
}
