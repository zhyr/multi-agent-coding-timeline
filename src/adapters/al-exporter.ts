import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { discoverSources, type DiscoverySpec } from './discovery.js';
import { decodeProjectPath, readSessionText, parseTimestamp, stringifyUnknown } from './util.js';
import {
  makeCapabilities,
  type AdapterCapabilities,
  type AdapterRecord,
  type AgentAdapter,
  type AgentSource,
  type CapabilityLevel,
  type DeclaredSourceDevice,
  type DiscoverOptions,
  type ParseIssue,
  type ParseResult,
  type ProjectEvidence,
  type SessionReference,
} from './types.js';

/**
 * Import adapter for Al-exporter archives (`agent-backup/`).
 *
 * Al-exporter exports agent conversations as one JSON file per thread plus a
 * `manifest.json`. It is not an agent-native layout, so this adapter is
 * intentionally explicit-root only: discovery requires both an explicit
 * `--source-root` and a `manifest.json` marker. It never scans default
 * home-directory locations.
 *
 * Schema 1.0.0 and 1.1.0 are both supported:
 *   1.1.0 adds the `session{}` / `device{}` blocks, message `id` / `line` /
 *   `tool_call{}`, an `interop.json` capability manifest and a `contract`
 *   pointer in `manifest.json`.
 *   1.0.0 has none of these; every 1.1.0-only field is then treated as absent,
 *   never as an empty string.
 *
 * The archive is a derived artifact. Two-hop provenance is preserved:
 *   provenance.source_path -> the Al-exporter JSON file
 *   raw_payload_ref        -> the original agent file recorded in meta.file_path
 *
 * Every event is `agent_reported` + `derived`; no Git data exists in an
 * Al-exporter archive, so this adapter can never produce verified commits or
 * pushes. `meta.project` is a path heuristic in Al-exporter and is ignored.
 */

const SPEC: DiscoverySpec = {
  agentId: 'al-exporter',
  defaultDirs: [],
  childNames: ['agent-backup'],
  markers: ['manifest.json'],
  format: 'al-exporter-json',
};

const TOOL_USE_PREFIX = /^\[Tool Use\]\s*([^\n]+)/;

const UPSTREAM_AGENTS: Record<string, { id: string; name: string }> = {
  codex: { id: 'codex', name: 'Codex' },
  cursor: { id: 'cursor', name: 'Cursor' },
  cursor_cli: { id: 'cursor-cli', name: 'Cursor CLI' },
  claude_code: { id: 'claude-code', name: 'Claude Code' },
  qoder: { id: 'qoder', name: 'Qoder' },
  trae: { id: 'trae', name: 'Trae' },
  traework: { id: 'trae-work', name: 'Trae Work' },
  workbuddy: { id: 'workbuddy', name: 'WorkBuddy' },
  codebuddy: { id: 'codebuddy', name: 'CodeBuddy' },
  zcode: { id: 'zcode', name: 'ZCode' },
  forge: { id: 'forge', name: 'Forge' },
  antigravity: { id: 'antigravity', name: 'Antigravity' },
  augment: { id: 'augment', name: 'Augment' },
  iflow: { id: 'iflow', name: 'iFlow' },
  windsurf: { id: 'windsurf', name: 'Windsurf' },
  vscode_copilot: { id: 'vscode-copilot', name: 'VS Code Copilot' },
  cline: { id: 'cline', name: 'Cline' },
  zed: { id: 'zed', name: 'Zed' },
  kiro: { id: 'kiro', name: 'Kiro' },
};

interface AlManifestItem {
  [key: string]: unknown;
}

interface AlDevice {
  id: string;
  basis?: string;
  hostname?: string;
  collectorId?: string;
  collectorHostname?: string;
  collectorPlatform?: string;
}

interface InteropField {
  schema_present?: boolean;
  applicable?: number;
  non_empty?: number;
  empty?: number;
  status?: string;
  notes?: string;
}

interface AlInterop {
  contract?: string;
  contract_version?: string;
  schema_version?: string;
  exporter_version?: string;
  records_total?: number;
  messages_total?: number;
  device?: AlDevice;
  fields?: Record<string, InteropField>;
  capabilities?: Record<string, string>;
  known_gaps?: string[];
}

interface ManifestCacheEntry {
  items: AlManifestItem[];
  exporterVersion?: string;
  schemaVersion?: string;
  contract?: Record<string, unknown>;
  device?: AlDevice;
  interop?: AlInterop;
  interopError?: string;
}

interface AlThreadMeta {
  [key: string]: unknown;
}

interface AlThreadMessage {
  [key: string]: unknown;
}

/** Identity fields read from one export file. All of them are optional in 1.0.0. */
interface ThreadIdentity {
  source?: string;
  filePath?: string;
  schemaVersion?: string;
  hasSessionBlock: boolean;
  nativeId?: string;
  nativeIdKind?: string;
  nativeIdSource?: string;
  cwd?: string;
  cwdSource?: string;
  gitRemote?: string;
  gitRemoteSource?: string;
  agentVersion?: string;
  device?: AlDevice;
  /** 1.0.0 only: WorkBuddy project directory recorded outside the session block. */
  projectDirectory?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeManifestPath(file: string): string | undefined {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return undefined;
  if (normalized.split('/').some((part) => part === '..')) return undefined;
  return normalized;
}

function safeNativeId(value: unknown, fallback: string): string {
  const raw = asString(value) ?? fallback;
  const cleaned = raw.replace(/[^A-Za-z0-9._:-]+/g, '-').slice(0, 200);
  return cleaned || fallback.replace(/[^A-Za-z0-9._:-]+/g, '-') || 'thread';
}

function readDevice(value: unknown): AlDevice | undefined {
  if (!isRecord(value)) return undefined;
  const id = asString(value.source_device_id);
  if (!id) return undefined;
  return {
    id,
    basis: asString(value.source_device_id_basis),
    hostname: asString(value.source_hostname),
    collectorId: asString(value.collector_device_id),
    collectorHostname: asString(value.collector_hostname),
    collectorPlatform: asString(value.collector_platform),
  };
}

function upstreamAgent(source: string | undefined, filePath: string | undefined): { id: string; name: string } {
  // Al-exporter aliases OpenCode into its Codex source. Recover the distinction
  // from the original file path so OpenCode history is not relabelled as Codex.
  if ((source === 'codex' || source === undefined) && filePath && /(^|\/)\.?opencode(\/|$)/i.test(filePath.replace(/\\/g, '/'))) {
    return { id: 'opencode', name: 'OpenCode' };
  }
  if (source && UPSTREAM_AGENTS[source]) return UPSTREAM_AGENTS[source]!;
  const slug = (source ?? 'unknown').replace(/[^A-Za-z0-9_-]+/g, '-') || 'unknown';
  return { id: `al-exporter-${slug}`, name: `Al-exporter import (${source ?? 'unknown'})` };
}

/**
 * Recover the agent-native session id from the original file recorded in
 * `meta.file_path`. This is the 1.0.0 path only: 1.1.0 exports declare
 * `session.native_id` and never need a path-derived id.
 *
 * Al-exporter's own `thread_id` is
 * `sha1(file_path + "\0" + session_id)[0..16]` and never equals a native id.
 * Only layouts that the native adapters themselves discover are accepted, so a
 * recovered id is comparable with `native_session_id` from a native scan.
 */
function recoverOriginalSessionId(agentId: string, filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const p = filePath.replace(/\\/g, '/');
  if (agentId === 'codex') {
    return /\/\.codex\/sessions\/.*\/rollout-(.+?)\.jsonl(?:\.zst)?$/.exec(p)?.[1];
  }
  if (agentId === 'opencode') {
    return /\/opencode\/storage\/session\/[^/]+\/([^/]+)\.json$/.exec(p)?.[1];
  }
  if (agentId === 'cursor') {
    return /\/\.cursor\/projects\/[^/]+\/agent-transcripts\//.test(p) && p.endsWith('.jsonl')
      ? path.basename(p, '.jsonl')
      : undefined;
  }
  if (agentId === 'claude-code') {
    return /\/\.claude\/projects\/[^/]+\/([^/]+)\.jsonl$/.exec(p)?.[1];
  }
  if (agentId === 'qoder') {
    return /\/\.qoder\/projects\/[^/]+\/([^/]+)\.jsonl$/.exec(p)?.[1];
  }
  if (agentId === 'trae') {
    return /\/\.trae[^/]*\/memory\/projects\/.*\/([^/]+)\.jsonl$/.exec(p)?.[1];
  }
  return undefined;
}

function identityFromDocument(document: Record<string, unknown>): ThreadIdentity {
  const meta = isRecord(document.meta) ? (document.meta as AlThreadMeta) : {};
  const session = isRecord(document.session) ? document.session : undefined;
  const extra = isRecord(meta.extra) ? meta.extra : {};
  const hasSessionBlock = session !== undefined;
  return {
    source: asString(meta.source),
    filePath: asString(meta.file_path),
    schemaVersion: asString(document.schema_version),
    projectDirectory: hasSessionBlock ? undefined : asString(extra.project_directory),
    hasSessionBlock,
    ...(session
      ? {
          nativeId: asString(session.native_id),
          nativeIdKind: asString(session.native_id_kind),
          nativeIdSource: asString(session.native_id_source),
          cwd: asString(session.cwd),
          cwdSource: asString(session.cwd_source),
          gitRemote: asString(session.git_remote),
          gitRemoteSource: asString(session.git_remote_source),
          agentVersion: asString(session.agent_version),
        }
      : {}),
    device: readDevice(document.device),
  };
}

/** Read only the identity fields needed to align a thread with a native session. */
async function readThreadIdentity(file: string): Promise<ThreadIdentity | undefined> {
  try {
    const document = JSON.parse(await readFile(file, 'utf8')) as unknown;
    return isRecord(document) ? identityFromDocument(document) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Project evidence.
 *
 * 1.1.0: `session.cwd` / `session.git_remote` are real ProjectEvidence. A null
 * value means the source did not record it, so no legacy field is substituted.
 * The declaration source is carried in `metadata` so the resolver output stays
 * explainable.
 *
 * 1.0.0 (no session block): WorkBuddy is the only source with a real cwd
 * (`extra.project_directory`); otherwise the agent-native project directory is
 * decoded from `meta.file_path` as a path hint. `meta.project` is a path
 * heuristic in Al-exporter (e.g. "10", "examples") and is never used.
 */
function projectEvidenceFromThread(
  identity: ThreadIdentity,
  sourceName: string | undefined,
): ProjectEvidence {
  const hints: string[] = [];
  const metadata: Record<string, string> = {};
  let cwd: string | undefined;
  let gitRemote: string | undefined;

  if (identity.hasSessionBlock) {
    if (identity.cwd) {
      cwd = identity.cwd;
      metadata.cwd_source = identity.cwdSource ?? 'session.cwd';
    }
    if (identity.gitRemote) {
      gitRemote = identity.gitRemote;
      metadata.git_remote_source = identity.gitRemoteSource ?? 'session.git_remote';
    }
  } else if (sourceName === 'workbuddy') {
    cwd = identity.projectDirectory;
    if (cwd) metadata.cwd_source = 'workbuddy.extra.project_directory (1.0.0 fallback)';
  }

  if (cwd) hints.push(cwd);
  if (identity.filePath) {
    const normalized = identity.filePath.replace(/\\/g, '/');
    for (const pattern of [
      /\/\.claude\/projects\/([^/]+)\//,
      /\/\.qoder\/projects\/([^/]+)\//,
      /\/\.cursor\/projects\/([^/]+)\//,
    ]) {
      const match = normalized.match(pattern);
      if (match?.[1]) {
        hints.push(decodeProjectPath(match[1]));
        metadata.project_path_hint_source = identity.hasSessionBlock
          ? 'decoded meta.file_path (heuristic; no native cwd declared)'
          : 'decoded meta.file_path (1.0.0 fallback)';
      }
    }
  }

  return {
    ...(cwd ? { cwd } : {}),
    ...(gitRemote ? { gitRemote } : {}),
    ...(hints.length > 0 ? { projectPathHints: [...new Set(hints)] } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function capabilityFromStatus(status: string | undefined): CapabilityLevel {
  if (status === 'full') return 'verified';
  if (status === 'partial') return 'partial';
  // empty / absent / not_applicable / unknown: the schema may exist, but the
  // archive carries no data for it.
  return 'unavailable';
}

function interopFieldSummary(interop: AlInterop | undefined, name: string): string {
  const field = interop?.fields?.[name];
  if (!field) return `${name}=absent`;
  const ratio = `${field.non_empty ?? 0}/${field.applicable ?? 0}`;
  return `${name}=${ratio} non-empty (${field.status ?? 'unknown'})`;
}

export class AlExporterAdapter implements AgentAdapter {
  readonly id = 'al-exporter';
  readonly name = 'Al-exporter archive';
  readonly version = '1.1.0';

  private readonly manifests = new Map<string, ManifestCacheEntry>();
  private lastInterop?: AlInterop;

  async discoverSources(options: DiscoverOptions = {}): Promise<AgentSource[]> {
    return discoverSources(SPEC, options);
  }

  private async manifest(root: string): Promise<ManifestCacheEntry> {
    const cached = this.manifests.get(root);
    if (cached) return cached;
    const file = path.join(root, 'manifest.json');
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
    } catch (error) {
      throw new Error(`invalid Al-exporter manifest at ${file}: ${(error as Error).message}`);
    }
    if (!isRecord(raw) || !Array.isArray(raw.items)) {
      throw new Error(`invalid Al-exporter manifest at ${file}: missing items[]`);
    }
    const contract = isRecord(raw.contract) ? raw.contract : undefined;
    const interop = await this.readInterop(root, contract);
    if (interop.interop) this.lastInterop = interop.interop;
    const entry: ManifestCacheEntry = {
      items: raw.items.filter(isRecord) as AlManifestItem[],
      exporterVersion: asString(raw.exporter_version),
      schemaVersion: asString(raw.schema_version),
      contract,
      device: readDevice(raw.device),
      ...interop,
    };
    this.manifests.set(root, entry);
    return entry;
  }

  private async readInterop(
    root: string,
    contract: Record<string, unknown> | undefined,
  ): Promise<{ interop?: AlInterop; interopError?: string }> {
    const declared = asString(contract?.capabilities) ?? 'interop.json';
    const relative = normalizeManifestPath(declared);
    if (!relative) return { interopError: `unsafe interop path in manifest contract: ${declared}` };
    const file = path.resolve(root, relative);
    if (file !== root && !file.startsWith(root + path.sep)) {
      return { interopError: `interop path escapes the archive root: ${declared}` };
    }
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
      if (!isRecord(raw)) return { interopError: 'interop.json is not a JSON object' };
      return {
        interop: {
          contract: asString(raw.contract),
          contract_version: asString(raw.contract_version),
          schema_version: asString(raw.schema_version),
          exporter_version: asString(raw.exporter_version),
          records_total: asNumber(raw.records_total),
          messages_total: asNumber(raw.messages_total),
          device: readDevice(raw.device),
          fields: isRecord(raw.fields) ? (raw.fields as Record<string, InteropField>) : undefined,
          capabilities: isRecord(raw.capabilities)
            ? (raw.capabilities as Record<string, string>)
            : undefined,
          known_gaps: Array.isArray(raw.known_gaps)
            ? raw.known_gaps.filter((g): g is string => typeof g === 'string')
            : undefined,
        },
      };
    } catch (error) {
      // A 1.0.0 archive has no interop.json at all: that is "absent", not an error.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return contract ? { interopError: `manifest contract declares ${declared}, but the file is missing` } : {};
      }
      return { interopError: `interop.json unreadable: ${(error as Error).message}` };
    }
  }

  async declaredSourceDevice(source: AgentSource): Promise<DeclaredSourceDevice | undefined> {
    if (!source.readable) return undefined;
    const manifest = await this.manifest(source.root);
    const device = manifest.device ?? manifest.interop?.device;
    if (!device) return undefined;
    return {
      device_id: device.id,
      basis: device.basis,
      hostname: device.hostname,
      source: manifest.device ? 'manifest.device' : 'interop.device',
    };
  }

  async scanSessions(source: AgentSource): Promise<SessionReference[]> {
    if (!source.readable) return [];
    const manifest = await this.manifest(source.root);
    const root = path.resolve(source.root);
    const sessions: SessionReference[] = [];
    const usedIds = new Set<string>();
    let missing = 0;
    let skippedSymlinks = 0;
    let fromSession = 0;
    let recoveredIds = 0;
    let fallbackIds = 0;

    for (let index = 0; index < manifest.items.length; index += 1) {
      const item = manifest.items[index]!;
      const file = asString(item.file);
      if (!file) continue;
      const relative = normalizeManifestPath(file);
      if (!relative) continue;
      const absolute = path.resolve(root, relative);
      if (absolute !== root && !absolute.startsWith(root + path.sep)) continue;

      let info;
      try {
        info = await lstat(absolute);
      } catch {
        missing += 1;
        continue;
      }
      if (info.isSymbolicLink()) {
        skippedSymlinks += 1;
        continue;
      }
      if (!info.isFile()) continue;

      const identity = await readThreadIdentity(absolute);
      const sourceName = identity?.source ?? asString(item.source);
      const agent = upstreamAgent(sourceName, identity?.filePath);
      const declaredId = identity?.nativeId;
      const recoveredId = declaredId ? undefined : recoverOriginalSessionId(agent.id, identity?.filePath);
      const idSource = declaredId
        ? 'session.native_id'
        : recoveredId
          ? 'meta.file_path'
          : 'manifest.thread_id';
      if (declaredId) fromSession += 1;
      else if (recoveredId) recoveredIds += 1;
      else fallbackIds += 1;

      const baseId = safeNativeId(
        declaredId ?? recoveredId ?? item.thread_id,
        path.basename(relative, path.extname(relative)),
      );
      let nativeId = baseId;
      if (usedIds.has(nativeId)) nativeId = `${baseId}#${index}`;
      usedIds.add(nativeId);

      const evidence = projectEvidenceFromThread(identity ?? { hasSessionBlock: false }, sourceName);
      const recordDevice = identity?.device;

      sessions.push({
        native_session_id: nativeId,
        source,
        path: absolute,
        relative_path: relative,
        size_bytes: info.size,
        modified_at: info.mtime.toISOString(),
        project_evidence: evidence,
        metadata: {
          skipped_symlinks: skippedSymlinks,
          al_exporter_source: sourceName,
          al_exporter_thread_id: asString(item.thread_id),
          al_exporter_original_session_id: recoveredId,
          al_exporter_session_id_source: idSource,
          al_exporter_native_id_kind: identity?.nativeIdKind,
          al_exporter_native_id_origin: identity?.nativeIdSource,
          al_exporter_schema_version: identity?.schemaVersion ?? manifest.schemaVersion,
          al_exporter_cwd_source: evidence.metadata?.cwd_source,
          al_exporter_git_remote_source: evidence.metadata?.git_remote_source,
          al_exporter_agent_version: identity?.agentVersion,
          al_exporter_record_device_id: recordDevice?.id,
          al_exporter_agent: agent.id,
          al_exporter_hash: asString(item.hash),
          al_exporter_sha256: asString(item.sha256),
          al_exporter_version: manifest.exporterVersion,
        },
      });
    }

    source.metadata = {
      ...source.metadata,
      matched_layout: true,
      manifest_items: manifest.items.length,
      missing_items: missing,
      skipped_symlinks: skippedSymlinks,
      native_ids_from_session: fromSession,
      native_session_ids_recovered: recoveredIds,
      native_ids_fallback: fallbackIds,
      schema_version: manifest.schemaVersion,
      contract_version: asString(manifest.contract?.version),
      interop_present: !!manifest.interop,
      ...(manifest.interopError ? { interop_error: manifest.interopError } : {}),
      ...(manifest.device ? { declared_device_id: manifest.device.id } : {}),
    };
    sessions.sort((a, b) => a.relative_path.localeCompare(b.relative_path));
    return sessions;
  }

  async parseSession(session: SessionReference): Promise<ParseResult> {
    const issues: ParseIssue[] = [];
    const read = await readSessionText(session);
    issues.push(...read.issues);

    let document: unknown;
    try {
      document = JSON.parse(read.text) as unknown;
    } catch (error) {
      issues.push({ line: 0, reason: `invalid thread JSON: ${(error as Error).message}` });
      return { records: [], issues, truncated: read.truncated };
    }
    if (!isRecord(document)) {
      issues.push({ line: 0, reason: 'thread record is not a JSON object' });
      return { records: [], issues, truncated: read.truncated };
    }

    const identity = identityFromDocument(document);
    const sourceName = identity.source ?? asString(session.metadata?.al_exporter_source);
    const evidence = projectEvidenceFromThread(identity, sourceName);
    const agent = upstreamAgent(sourceName, identity.filePath);
    const exporterVersion = asString(session.metadata?.al_exporter_version);
    const agentOverride = {
      id: agent.id,
      name: agent.name,
      version: identity.agentVersion ?? (exporterVersion ? `al-exporter-${exporterVersion}` : undefined),
    };
    const threadId = asString(document.thread_id) ?? session.native_session_id;

    const messages = document.messages;
    if (!Array.isArray(messages)) {
      issues.push({ line: 0, reason: 'thread has no messages[] array' });
      return { records: [], issues, truncated: read.truncated, project_evidence: evidence };
    }

    const records: AdapterRecord[] = [];
    let sequence = 0;
    let started: string | undefined;
    let ended: string | undefined;
    let model: string | undefined;
    const identityCounts = new Map<string, number>();

    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (!isRecord(message)) {
        issues.push({ line: index + 1, reason: 'message is not a JSON object' });
        continue;
      }
      const typed = message as AlThreadMessage;
      const role = asString(typed.role);
      if (!role) {
        issues.push({ line: index + 1, reason: 'message has no role; record skipped' });
        continue;
      }
      const content = stringifyUnknown(typed.content)?.trim();
      if (!content) {
        issues.push({ line: index + 1, reason: 'message has no content; record skipped' });
        continue;
      }

      const messageMeta = isRecord(typed.meta) ? typed.meta : {};
      const metaKind = asString(messageMeta.kind);
      const metaName = asString(messageMeta.name);
      const toolMatch = role === 'assistant' ? content.match(TOOL_USE_PREFIX) : null;
      const toolCall = isRecord(typed.tool_call) ? typed.tool_call : undefined;
      const toolPhase = asString(toolCall?.phase);
      const toolStatus = asString(toolCall?.status);
      const toolCallId = asString(toolCall?.call_id);

      const isToolUse = toolPhase === 'call' || metaKind === 'tool_use' || toolMatch !== null;
      const isToolResult = toolPhase === 'result' || metaKind === 'tool_result';
      const isToolError = toolPhase === 'error' || (isToolResult && /^(failed|error)$/i.test(toolStatus ?? ''));

      let eventType: string;
      let toolName: string | undefined;
      if (isToolUse && !isToolError) {
        eventType = 'agent.tool.started';
        toolName = asString(toolCall?.name) ?? metaName ?? toolMatch?.[1]?.trim();
      } else if (isToolError) {
        eventType = 'agent.tool.failed';
        toolName = asString(toolCall?.name) ?? metaName;
      } else if (isToolResult) {
        eventType = 'agent.tool.completed';
        toolName = asString(toolCall?.name) ?? metaName;
      } else if (role === 'user') {
        eventType = 'agent.user_request.submitted';
      } else if (role === 'assistant') {
        eventType = 'agent.response.received';
      } else if (role === 'tool') {
        eventType = 'agent.tool.completed';
        toolName = asString(toolCall?.name) ?? metaName;
      } else {
        eventType = 'agent.message.recorded';
      }

      // Message identity: prefer the source message id. Without one, fall back
      // to `session:<native_id>:L<line>`. Several messages can share one source
      // line (block-level export), so a `#n` suffix keeps the identity unique.
      const rawId = asString(typed.id);
      const lineNumber = asNumber(typed.line);
      let identityBase: string;
      let identitySource: 'message_id' | 'session_line' | 'message_index';
      if (rawId) {
        identityBase = rawId;
        identitySource = 'message_id';
      } else if (lineNumber !== undefined) {
        identityBase = `session:${session.native_session_id}:L${lineNumber}`;
        identitySource = 'session_line';
      } else {
        identityBase = `${session.native_session_id}:m${index}`;
        identitySource = 'message_index';
      }
      const seen = (identityCounts.get(identityBase) ?? 0) + 1;
      identityCounts.set(identityBase, seen);
      const nativeEventId = seen === 1 ? identityBase : `${identityBase}#${seen}`;
      const sourceRecordId =
        identitySource === 'message_id'
          ? `message:${rawId}`
          : identitySource === 'session_line'
            ? `message:L${lineNumber}`
            : `message:${index}`;

      let occurredAt: string | undefined;
      let precision: AdapterRecord['timestamp_precision'];
      if (typed.timestamp !== undefined) {
        const parsed = parseTimestamp(typed.timestamp);
        occurredAt = parsed.iso;
        precision = parsed.precision;
        if (!parsed.iso) {
          issues.push({ line: index + 1, reason: 'message timestamp is invalid; occurred_at omitted' });
        }
      }
      if (occurredAt) {
        started ??= occurredAt;
        ended = occurredAt;
      }
      const messageModel = asString(typed.model);
      model ??= messageModel;

      records.push({
        event_type: eventType,
        native_event_id: nativeEventId,
        occurred_at: occurredAt,
        timestamp_precision: precision,
        role,
        content,
        tool_name: toolName,
        tool_call_id: toolCallId,
        // A null tool status means "not recorded". It is never inferred from
        // the presence of a result, and never turned into success/failure.
        execution_status: toolStatus,
        model: messageModel,
        evidence_level: 'agent_reported',
        capture_level: 'derived',
        source_record_id: seen === 1 ? sourceRecordId : `${sourceRecordId}#${seen}`,
        source_line: lineNumber,
        sequence,
        agent_override: agentOverride,
        raw_payload_ref: identity.filePath,
        import_identity_source: identitySource,
        metadata: {
          al_exporter_source: sourceName,
          al_exporter_thread_id: threadId,
          al_exporter_schema_version: identity.schemaVersion,
          al_exporter_type: asString(document.type),
          original_role: role,
          ...(lineNumber !== undefined ? { al_exporter_message_line: lineNumber } : {}),
          ...(toolPhase ? { al_exporter_tool_phase: toolPhase } : {}),
          ...(metaKind ? { original_meta_kind: metaKind } : {}),
        },
      });
      sequence += 1;
    }

    return {
      records,
      issues,
      truncated: read.truncated,
      session_started_at: started,
      session_ended_at: ended,
      model,
      project_evidence: evidence,
    };
  }

  getCapabilities(): AdapterCapabilities {
    const interop = this.lastInterop;
    const status = (name: string): string | undefined =>
      interop?.capabilities?.[name] ?? interop?.fields?.[`messages[].${name}`]?.status;

    const projectStatus =
      interop?.capabilities?.session_cwd && interop.capabilities.session_cwd === 'full'
        ? 'full'
        : interop?.capabilities?.git_remote ?? interop?.capabilities?.session_cwd;
    const notes = [
      'Explicit --source-root only; requires manifest.json and never scans default home directories.',
      'Supports Al-exporter schema 1.0.0 and 1.1.0. 1.0.0 has no session/device blocks; those fields are treated as absent, never as empty strings.',
      '1.1.0 session.native_id is authoritative. meta.file_path recovery is the 1.0.0 fallback only; manifest.thread_id is the last resort.',
      'Message events use messages[].id when present; otherwise session:<native_id>:L<line> (with a #n suffix when several messages share a line).',
      'Two-hop provenance: source_path is the export file, raw_payload_ref is the original agent file from meta.file_path.',
      'meta.created_at is a file mtime and is never used as occurred_at; only messages[].timestamp is authoritative.',
      'meta.project is a path heuristic (observed values include "10" and "examples") and is ignored.',
      'Project evidence (1.1.0): session.cwd and session.git_remote are real evidence and their declaration source is kept in evidence.metadata. 1.0.0 falls back to WorkBuddy extra.project_directory and file_path hints.',
      'device.source_device_id is declared by the archive; the engine adopts it only when --source-device is absent, and reports a conflict when both differ.',
      'Al-exporter aliases OpenCode into Codex; the original .opencode path is used to restore the opencode agent id.',
      'Structured tool_call drives tool events. A null status stays unknown; success or failure is never inferred.',
      'Imported events use the original agent id via agent_override, but session records still belong to the al-exporter adapter.',
      'Deterministic dedup: same agent + native session id + native message id. Inferred pairing (session id + type + time + content) remains for 1.0.0 and for rows without message ids.',
      'No Git commits/pushes exist in the archive, so this adapter never produces verified Git evidence.',
    ];
    if (interop) {
      notes.push(
        [
          'interop.json capability matrix (non-empty / applicable):',
          interopFieldSummary(interop, 'session.native_id'),
          interopFieldSummary(interop, 'session.cwd'),
          interopFieldSummary(interop, 'session.git_remote'),
          interopFieldSummary(interop, 'session.agent_version'),
          interopFieldSummary(interop, 'messages[].id'),
          interopFieldSummary(interop, 'messages[].line'),
          interopFieldSummary(interop, 'messages[].timestamp'),
          interopFieldSummary(interop, 'messages[].tool_call.name'),
          interopFieldSummary(interop, 'messages[].tool_call.status'),
          interopFieldSummary(interop, 'messages[].tool_call.call_id'),
        ].join(' '),
      );
      if (interop.known_gaps?.length) notes.push(`interop known gaps: ${interop.known_gaps.join(' ')}`);
    } else {
      notes.push(
        'No interop.json in this archive (schema 1.0.0 or a stripped export): absent and empty cannot be distinguished; capabilities fall back to observed 1.0.0 behaviour.',
      );
    }

    return makeCapabilities({
      discovery: 'verified',
      session_listing: 'verified',
      user_request: 'partial',
      agent_response: 'partial',
      tool_calls: interop ? capabilityFromStatus(status('tool_call_name')) : 'partial',
      task_status: 'unavailable',
      file_changes: 'unavailable',
      project_identity: interop ? capabilityFromStatus(projectStatus) : 'partial',
      timestamps: interop ? capabilityFromStatus(interop.capabilities?.message_timestamp) : 'partial',
      incremental_scan: 'verified',
      git_correlation: 'unavailable',
      formats: ['json', 'al-exporter-manifest', 'al-exporter-interop'],
      verification: 'partially_verified',
      ...(interop
        ? {
            interop: {
              contract: interop.contract,
              contract_version: interop.contract_version,
              schema_version: interop.schema_version,
              exporter_version: interop.exporter_version,
              records_total: interop.records_total,
              messages_total: interop.messages_total,
              capabilities: interop.capabilities,
              fields: Object.fromEntries(
                Object.entries(interop.fields ?? {}).map(([name, field]) => [
                  name,
                  {
                    schema_present: field.schema_present,
                    applicable: field.applicable,
                    non_empty: field.non_empty,
                    empty: field.empty,
                    status: field.status,
                  },
                ]),
              ),
              known_gaps: interop.known_gaps,
            },
          }
        : {}),
      notes,
    });
  }
}
