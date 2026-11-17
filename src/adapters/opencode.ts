import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { walkFiles } from '../core/fs.js';
import { discoverSources, type DiscoverySpec } from './discovery.js';
import { parseTimestamp, stringifyUnknown } from './util.js';
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
 * OpenCode. Verified against local data (2026-11-17):
 *   ~/.local/share/opencode/storage/
 *     project/<projectID>.json      { id, worktree, vcs, time }
 *     session/<projectID>/<sid>.json{ id, projectID, directory, title, time, version }
 *     message/<sid>/<mid>.json      { id, sessionID, role, time:{created,completed},
 *                                     modelID, providerID, path:{cwd,root}, error?, tokens }
 *     part/<mid>/<pid>.json         { id, sessionID, messageID, type, text? }
 *     session_diff/<sid>.json       array of file diffs (empty in the observed sample)
 *
 * Only the record shapes actually observed are converted. No tool/part type was
 * present in the local sample, so tool events are not emitted and tool_calls is
 * declared unavailable rather than guessed.
 */
const SPEC: DiscoverySpec = {
  agentId: 'opencode',
  defaultDirs: ['~/.local/share/opencode/storage'],
  markers: ['session', 'message'],
  childNames: [
    '.local/share/opencode/storage',
    'opencode/storage',
    'Library/Application Support/opencode/storage',
    '.opencode/storage',
  ],
  format: 'json',
};

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

interface OpenCodeSession {
  id?: string;
  projectID?: string;
  directory?: string;
  title?: string;
  version?: string;
  time?: { created?: number; updated?: number };
  summary?: { additions?: number; deletions?: number; files?: number };
}

interface OpenCodeMessage {
  id?: string;
  sessionID?: string;
  role?: string;
  time?: { created?: number; completed?: number };
  modelID?: string;
  providerID?: string;
  agent?: string;
  mode?: string;
  parentID?: string;
  path?: { cwd?: string; root?: string };
  error?: { name?: string; data?: { message?: string; statusCode?: number } };
  tokens?: unknown;
  cost?: number;
}

interface OpenCodePart {
  id?: string;
  messageID?: string;
  type?: string;
  text?: string;
  [key: string]: unknown;
}

function safeId(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : undefined;
}

async function readJson<T>(file: string, issues: ParseIssue[], line: number): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    issues.push({ line, reason: `cannot read ${path.basename(file)}: ${(error as Error).message}` });
    return undefined;
  }
}

async function readProjectWorktrees(storageRoot: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let entries: string[] = [];
  try {
    entries = (await walkFiles(path.join(storageRoot, 'project'), { maxDepth: 1 })).files;
  } catch {
    return map;
  }
  for (const relative of entries) {
    if (!relative.endsWith('.json')) continue;
    const parsed = await readFile(path.join(storageRoot, 'project', relative), 'utf8')
      .then((text) => JSON.parse(text) as { id?: string; worktree?: string })
      .catch(() => undefined);
    if (parsed?.id && typeof parsed.worktree === 'string') map.set(parsed.id, parsed.worktree);
  }
  return map;
}

function evidenceOf(session: OpenCodeSession, worktrees: Map<string, string>): ProjectEvidence {
  const cwd = typeof session.directory === 'string' ? session.directory : undefined;
  const projectId = typeof session.projectID === 'string' ? session.projectID : undefined;
  const worktree = projectId ? worktrees.get(projectId) : undefined;
  const hints = [...new Set([cwd, worktree].filter((p): p is string => typeof p === 'string' && p.length > 0))];
  return {
    cwd: cwd ?? worktree,
    nativeProjectId: projectId,
    projectPathHints: hints,
    metadata: projectId ? { opencode_project_id: projectId } : {},
  };
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly id = 'opencode';
  readonly name = 'OpenCode';
  readonly version = '1.0.0';

  async discoverSources(options: DiscoverOptions = {}): Promise<AgentSource[]> {
    return discoverSources(SPEC, options);
  }

  async scanSessions(source: AgentSource): Promise<SessionReference[]> {
    if (!source.readable) return [];
    const storageRoot = source.root;
    const walked = await walkFiles(storageRoot, {
      maxDepth: 4,
      maxFiles: 20_000,
      predicate: (relative, isDirectory) => (isDirectory ? !relative.startsWith('part') && !relative.startsWith('message') : /^session\/[^/]+\/[^/]+\.json$/.test(relative)),
    });
    const worktrees = await readProjectWorktrees(storageRoot);
    const sessions: SessionReference[] = [];
    for (const relative of walked.files) {
      const absolute = path.join(storageRoot, relative);
      const parsed = await readFile(absolute, 'utf8')
        .then((text) => JSON.parse(text) as OpenCodeSession)
        .catch(() => undefined);
      if (!parsed) continue;
      let size = 0;
      let modified: string | undefined;
      try {
        const info = await stat(absolute);
        size = info.size;
        modified = info.mtime.toISOString();
      } catch {
        continue;
      }
      const nativeId = safeId(parsed.id) ?? path.basename(relative, '.json');
      sessions.push({
        native_session_id: nativeId,
        source,
        path: absolute,
        relative_path: relative,
        size_bytes: size,
        modified_at: modified,
        project_evidence: evidenceOf(parsed, worktrees),
        metadata: {
          skipped_symlinks: walked.skippedSymlinks,
          opencode_project_id: parsed.projectID,
          title: parsed.title,
          opencode_version: parsed.version,
        },
      });
    }
    sessions.sort((a, b) => a.relative_path.localeCompare(b.relative_path));
    return sessions;
  }

  async parseSession(session: SessionReference): Promise<ParseResult> {
    const issues: ParseIssue[] = [];
    const sessionRecord = await readJson<OpenCodeSession>(session.path, issues, 0);
    if (!sessionRecord) return { records: [], issues, truncated: false };

    const rawId = sessionRecord.id;
    if (typeof rawId === 'string' && !safeId(rawId)) {
      return {
        records: [],
        issues: [{ line: 0, reason: `session id is unsafe and was rejected: ${rawId.slice(0, 80)}` }],
        truncated: false,
      };
    }
    const sessionId = safeId(rawId) ?? safeId(session.native_session_id);
    if (!sessionId) {
      return { records: [], issues: [{ line: 0, reason: 'session id is missing or unsafe; records not read' }], truncated: false };
    }
    const storageRoot = session.source.root;
    const worktrees = await readProjectWorktrees(storageRoot);
    const evidence = evidenceOf(sessionRecord, worktrees);

    const messageDir = path.join(storageRoot, 'message', sessionId);
    let messageFiles: string[] = [];
    try {
      messageFiles = (await walkFiles(messageDir, { maxDepth: 1 })).files.filter((f) => f.endsWith('.json'));
    } catch {
      issues.push({ line: 0, reason: `message directory missing for session ${sessionId}` });
    }

    const messages: OpenCodeMessage[] = [];
    for (const relative of messageFiles) {
      const parsed = await readJson<OpenCodeMessage>(path.join(messageDir, relative), issues, messages.length + 1);
      if (parsed) messages.push(parsed);
    }
    messages.sort((a, b) => {
      const ta = typeof a.time?.created === 'number' ? a.time.created : 0;
      const tb = typeof b.time?.created === 'number' ? b.time.created : 0;
      if (ta !== tb) return ta - tb;
      return String(a.id ?? '').localeCompare(String(b.id ?? ''));
    });

    const records: AdapterRecord[] = [];
    let sequence = 0;
    let started: string | undefined;
    let ended: string | undefined;
    let model: string | undefined;

    for (const message of messages) {
      const messageId = safeId(message.id);
      if (!messageId) {
        issues.push({ line: records.length + 1, reason: 'message id is missing or unsafe; message skipped' });
        continue;
      }
      const role = typeof message.role === 'string' ? message.role : 'unknown';
      const created = parseTimestamp(message.time?.created);
      const completed = parseTimestamp(message.time?.completed);
      const at = role === 'assistant' ? completed.iso ?? created.iso : created.iso;
      const precision = role === 'assistant' ? completed.precision : created.precision;
      if (at) {
        if (!started) started = at;
        ended = at;
      }
      if (typeof message.modelID === 'string') model = message.modelID;

      const parts = await this.readParts(storageRoot, messageId, issues);
      const text = parts
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string)
        .join('\n')
        .trim();

      const base = {
        source_record_id: messageId,
        sequence,
        occurred_at: at,
        timestamp_precision: precision,
        raw_type: role,
        model: typeof message.modelID === 'string' ? message.modelID : model,
        project_evidence: evidence,
      };

      if (message.error) {
        records.push({
          ...base,
          event_type: 'agent.response.received',
          native_event_id: messageId,
          role,
          content: text || undefined,
          execution_status: 'failed',
          error_message: stringifyUnknown(message.error.data?.message ?? message.error.name),
          evidence_level: 'agent_reported',
          capture_level: 'reported',
          metadata: {
            provider: message.providerID,
            opencode_agent: message.agent,
            mode: message.mode,
            status_code: message.error.data?.statusCode,
            part_types: parts.map((p) => p.type).filter(Boolean),
          },
        });
        sequence += 1;
        continue;
      }

      const isUser = role === 'user';
      records.push({
        ...base,
        event_type: isUser ? 'agent.user_request.submitted' : 'agent.response.received',
        native_event_id: messageId,
        role,
        content: text || undefined,
        evidence_level: 'verified',
        capture_level: 'observed',
        metadata: {
          provider: message.providerID,
          opencode_agent: message.agent,
          mode: message.mode,
          parent_id: message.parentID,
          tokens: message.tokens,
          part_types: parts.map((p) => p.type).filter(Boolean),
        },
      });
      sequence += 1;
    }

    const sessionStart = parseTimestamp(sessionRecord.time?.created).iso ?? started;
    const sessionEnd = parseTimestamp(sessionRecord.time?.updated).iso ?? ended;

    return {
      records,
      issues,
      truncated: false,
      session_started_at: sessionStart,
      session_ended_at: sessionEnd,
      model,
      native_project_id: sessionRecord.directory,
      project_evidence: evidence,
    };
  }

  private async readParts(storageRoot: string, messageId: string, issues: ParseIssue[]): Promise<OpenCodePart[]> {
    const partDir = path.join(storageRoot, 'part', messageId);
    let files: string[] = [];
    try {
      files = (await walkFiles(partDir, { maxDepth: 1 })).files.filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const parts: OpenCodePart[] = [];
    for (const relative of files) {
      const parsed = await readJson<OpenCodePart>(path.join(partDir, relative), issues, parts.length + 1);
      if (parsed) parts.push(parsed);
    }
    parts.sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')));
    return parts;
  }

  getCapabilities(): AdapterCapabilities {
    return makeCapabilities({
      discovery: 'verified',
      session_listing: 'verified',
      user_request: 'verified',
      agent_response: 'verified',
      timestamps: 'verified',
      project_identity: 'verified',
      incremental_scan: 'verified',
      tool_calls: 'unavailable',
      file_changes: 'unavailable',
      ai_request: 'unavailable',
      task_status: 'unavailable',
      git_correlation: 'unavailable',
      formats: ['json'],
      verification: 'partially_verified',
      notes: [
        'Real local format observed: ~/.local/share/opencode/storage/{project,session,message,part}/*.json.',
        'Verified against one real session (2 messages, 1 text part) on 2026-11-17; project identity from session.directory.',
        'Message and part records are authoritative for roles, text and millisecond timestamps.',
        'Only part.type="text" was present locally. Other part types are indexed in metadata.part_types but not converted into events.',
        'No tool-call part was observed, so tool_calls stays unavailable; session_diff was empty, so file_changes stays unavailable.',
        'API errors recorded by OpenCode are exported as agent_reported events with execution_status=failed.',
      ],
    });
  }
}
