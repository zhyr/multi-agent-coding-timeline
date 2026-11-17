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
  type DiscoverOptions,
  type ParseIssue,
  type ParseResult,
  type ProjectEvidence,
  type SessionReference,
} from './types.js';

/**
 * Import adapter for Al-exporter archives (`agent-backup/`).
 *
 * Al-exporter is a sibling tool that exports agent conversations as one JSON
 * file per thread plus a `manifest.json`. It is not an agent-native layout, so
 * this adapter is intentionally explicit-root only: discovery requires both an
 * explicit `--source-root` and a `manifest.json` marker. It never scans default
 * home-directory locations.
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

interface AlManifest {
  items: AlManifestItem[];
  exporterVersion?: string;
}

interface ManifestCacheEntry {
  items: AlManifestItem[];
  exporterVersion?: string;
}

interface AlThreadMeta {
  [key: string]: unknown;
}

interface AlThreadMessage {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
 * `meta.file_path`. Al-exporter's own `thread_id` is
 * `sha1(file_path + "\0" + session_id)[0..16]` and never equals a native id;
 * `meta.extra.session_id` is absent from every record in the observed archive.
 * The path is therefore the only bridge to the native session identity.
 *
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

/** Read only the identity fields needed to align a thread with a native session. */
async function readThreadIdentity(file: string): Promise<{ source?: string; filePath?: string } | undefined> {
  try {
    const document = JSON.parse(await readFile(file, 'utf8')) as unknown;
    if (!isRecord(document)) return undefined;
    const meta = isRecord(document.meta) ? document.meta : {};
    return { source: asString(meta.source), filePath: asString(meta.file_path) };
  } catch {
    return undefined;
  }
}

/**
 * Project evidence is deliberately narrow:
 *  1. WorkBuddy is the only source that records a real cwd (`extra.project_directory`).
 *  2. Otherwise, decode the agent-native project directory that may survive in
 *     `meta.file_path` (Claude Code, Qoder, Cursor transcripts).
 * `meta.project` is a path heuristic in Al-exporter (e.g. "10", "examples") and is
 * never used.
 */
function projectEvidenceFromThread(meta: AlThreadMeta, sourceName: string | undefined): ProjectEvidence {
  const extra = isRecord(meta.extra) ? meta.extra : {};
  // Only WorkBuddy records a real cwd; do not trust a same-named field elsewhere.
  const cwd = sourceName === 'workbuddy' ? asString(extra.project_directory) : undefined;
  const filePath = asString(meta.file_path);
  const hints: string[] = [];
  if (cwd) hints.push(cwd);
  if (filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    for (const pattern of [
      /\/\.claude\/projects\/([^/]+)\//,
      /\/\.qoder\/projects\/([^/]+)\//,
      /\/\.cursor\/projects\/([^/]+)\//,
    ]) {
      const match = normalized.match(pattern);
      if (match?.[1]) hints.push(decodeProjectPath(match[1]));
    }
  }
  return {
    ...(cwd ? { cwd } : {}),
    ...(hints.length > 0 ? { projectPathHints: [...new Set(hints)] } : {}),
  };
}

export class AlExporterAdapter implements AgentAdapter {
  readonly id = 'al-exporter';
  readonly name = 'Al-exporter archive';
  readonly version = '1.0.0';

  private readonly manifests = new Map<string, ManifestCacheEntry>();

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
    const entry: ManifestCacheEntry = {
      items: raw.items.filter(isRecord) as AlManifestItem[],
      exporterVersion: asString(raw.exporter_version),
    };
    this.manifests.set(root, entry);
    return entry;
  }

  async scanSessions(source: AgentSource): Promise<SessionReference[]> {
    if (!source.readable) return [];
    const manifest = await this.manifest(source.root);
    const root = path.resolve(source.root);
    const sessions: SessionReference[] = [];
    const usedIds = new Set<string>();
    let missing = 0;
    let skippedSymlinks = 0;
    let recoveredIds = 0;

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
      const recoveredId = recoverOriginalSessionId(agent.id, identity?.filePath);
      if (recoveredId) recoveredIds += 1;

      const baseId = safeNativeId(recoveredId ?? item.thread_id, path.basename(relative, path.extname(relative)));
      let nativeId = baseId;
      if (usedIds.has(nativeId)) nativeId = `${baseId}#${index}`;
      usedIds.add(nativeId);

      sessions.push({
        native_session_id: nativeId,
        source,
        path: absolute,
        relative_path: relative,
        size_bytes: info.size,
        modified_at: info.mtime.toISOString(),
        project_evidence: {},
        metadata: {
          skipped_symlinks: skippedSymlinks,
          al_exporter_source: sourceName,
          al_exporter_thread_id: asString(item.thread_id),
          al_exporter_original_session_id: recoveredId,
          al_exporter_session_id_source: recoveredId ? 'meta.file_path' : 'manifest.thread_id',
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
      native_session_ids_recovered: recoveredIds,
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

    const meta = isRecord(document.meta) ? (document.meta as AlThreadMeta) : {};
    const filePath = asString(meta.file_path);
    const sourceName = asString(meta.source) ?? asString(session.metadata?.al_exporter_source);
    const evidence = projectEvidenceFromThread(meta, sourceName);
    const agent = upstreamAgent(sourceName, filePath);
    const exporterVersion = asString(session.metadata?.al_exporter_version);
    const agentOverride = {
      id: agent.id,
      name: agent.name,
      version: exporterVersion ? `al-exporter-${exporterVersion}` : undefined,
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
      const isToolUse = metaKind === 'tool_use' || toolMatch !== null;
      const isToolResult = metaKind === 'tool_result';

      let eventType: string;
      let toolName: string | undefined;
      if (isToolUse) {
        eventType = 'agent.tool.started';
        toolName = metaName ?? toolMatch?.[1]?.trim();
      } else if (isToolResult) {
        eventType = 'agent.tool.completed';
        toolName = metaName;
      } else if (role === 'user') {
        eventType = 'agent.user_request.submitted';
      } else if (role === 'assistant') {
        eventType = 'agent.response.received';
      } else {
        eventType = 'agent.message.recorded';
      }

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
        native_event_id: `${session.native_session_id}:m${index}`,
        occurred_at: occurredAt,
        timestamp_precision: precision,
        role,
        content,
        tool_name: toolName,
        model: messageModel,
        evidence_level: 'agent_reported',
        capture_level: 'derived',
        source_record_id: `message:${index}`,
        sequence,
        agent_override: agentOverride,
        raw_payload_ref: filePath,
        metadata: {
          al_exporter_source: sourceName,
          al_exporter_thread_id: threadId,
          al_exporter_type: asString(document.type),
          original_role: role,
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
    return makeCapabilities({
      discovery: 'verified',
      session_listing: 'verified',
      user_request: 'partial',
      agent_response: 'partial',
      tool_calls: 'partial',
      task_status: 'unavailable',
      file_changes: 'unavailable',
      project_identity: 'partial',
      timestamps: 'partial',
      incremental_scan: 'verified',
      git_correlation: 'unavailable',
      formats: ['json', 'al-exporter-manifest'],
      verification: 'partially_verified',
      notes: [
        'Explicit --source-root only; requires manifest.json and never scans default home directories.',
        'Each manifest item maps to one thread JSON; messages become events with agent_reported + derived evidence.',
        'Two-hop provenance: source_path is the export file, raw_payload_ref is the original agent file from meta.file_path.',
        'meta.created_at is a file mtime and is never used as occurred_at; only messages[].timestamp is authoritative.',
        'meta.project is a path heuristic (observed values include "10" and "examples") and is ignored.',
        'Project evidence: WorkBuddy extra.project_directory, then decoded Claude/Qoder/Cursor project directories from meta.file_path.',
        'Al-exporter aliases OpenCode into Codex; the original .opencode path is used to restore the opencode agent id.',
        'Tool calls are recovered only from [Tool Use] text or message meta.kind; no execution status or file changes exist.',
        'Imported events use the original agent id via agent_override, but session records still belong to the al-exporter adapter.',
        'The native session id is recovered from meta.file_path for native layouts; other records keep the Al-exporter thread id and cannot be aligned.',
        'An imported event is folded into a native event only on an exact agent + session id + type + time + content match, and the fold is marked inferred.',
        'No Git commits/pushes exist in the archive, so this adapter never produces verified Git evidence.',
      ],
    });
  }
}
