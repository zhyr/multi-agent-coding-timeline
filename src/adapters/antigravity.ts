import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { readTextLimited } from '../core/fs.js';
import { discoverSources, scanJsonlSessions, type DiscoverySpec } from './discovery.js';
import { openReadOnlySqlite, parseTimestamp, safeSqliteRows } from './util.js';
import {
  makeCapabilities,
  type AdapterCapabilities,
  type AgentAdapter,
  type AgentSource,
  type DiscoverOptions,
  type ParseIssue,
  type ParseResult,
  type ProjectEvidence,
  type SessionReference,
} from './types.js';

/**
 * Google Antigravity. Verified against local data (2026-11-21):
 *   ~/.gemini/antigravity-ide/brain/<conversation-uuid>/{task,implementation_plan,walkthrough,...}.md
 *   ~/.gemini/antigravity-ide/brain/<conversation-uuid>/<artifact>.md.metadata.json
 *   ~/.gemini/antigravity-ide/brain/<conversation-uuid>/<artifact>.md.resolved[.N]
 *   ~/.gemini/antigravity-ide/{conversations,implicit}/*.pb          (encrypted, not read)
 *   ~/.gemini/antigravity/conversation_summaries.db                  (optional workspace_uris)
 *
 * Brain artifacts are agent-authored planning/completion documents, not the raw
 * conversation. The conversation blobs are encrypted protocol buffers and are
 * deliberately left unread; the scan inventory reports them instead of guessing.
 */
const SPEC: DiscoverySpec = {
  agentId: 'antigravity',
  defaultDirs: ['~/.gemini/antigravity-ide', '~/.gemini/antigravity'],
  markers: ['brain'],
  childNames: ['antigravity-ide', 'antigravity'],
  format: 'markdown',
};

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const ARTIFACT_ORDER = ['task', 'implementation_plan', 'walkthrough', 'artifact'] as const;

type ArtifactKind = (typeof ARTIFACT_ORDER)[number];

interface ArtifactDescriptor {
  /** Path relative to the source root, e.g. brain/<uuid>/task.md. */
  relative: string;
  kind: ArtifactKind;
  /** Raw ARTIFACT_TYPE_* value from the sibling metadata file. */
  rawType?: string;
  summary?: string;
  updatedAt?: string;
  revisionCount: number;
}

function artifactKind(rawType: string | undefined, filename: string): ArtifactKind {
  if (rawType === 'ARTIFACT_TYPE_TASK') return 'task';
  if (rawType === 'ARTIFACT_TYPE_IMPLEMENTATION_PLAN') return 'implementation_plan';
  if (rawType === 'ARTIFACT_TYPE_WALKTHROUGH') return 'walkthrough';
  const stem = filename.replace(/\.md$/, '').toLowerCase();
  if (stem === 'task' || stem.endsWith('_task')) return 'task';
  if (stem.includes('implementation_plan')) return 'implementation_plan';
  if (stem.includes('walkthrough')) return 'walkthrough';
  return 'artifact';
}

function conversationOf(relative: string): string | undefined {
  const parts = relative.split('/');
  return parts.length >= 3 && parts[0] === 'brain' ? parts[1] : undefined;
}

function primaryFirst(relative: string): number {
  const filename = relative.split('/').pop() ?? relative;
  const kind = artifactKind(undefined, filename);
  const index = ARTIFACT_ORDER.indexOf(kind);
  return index === -1 ? ARTIFACT_ORDER.length : index;
}

function parseWorkspaceUris(value: unknown): string[] {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      raw = JSON.parse(trimmed) as unknown;
    } catch {
      raw = trimmed.split(/[\n,]/);
    }
  }
  if (!Array.isArray(raw)) return [];
  const paths: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    let text = entry.trim();
    if (text.startsWith('file://')) {
      try {
        text = decodeURIComponent(new URL(text).pathname);
      } catch {
        /* keep the raw value */
      }
    }
    if (text && !paths.includes(text)) paths.push(text);
  }
  return paths;
}

function evidenceFromSummary(row: Record<string, unknown> | undefined): ProjectEvidence {
  if (!row) return {};
  const paths = parseWorkspaceUris(row.workspace_uris);
  const evidence: ProjectEvidence = {};
  if (paths.length > 0) {
    evidence.projectPathHints = paths;
    if (paths.length === 1) evidence.cwd = paths[0];
  }
  if (typeof row.project_id === 'string' && row.project_id) evidence.nativeProjectId = row.project_id;
  const metadata: Record<string, string> = {};
  if (typeof row.title === 'string' && row.title) metadata.conversation_title = row.title;
  if (typeof row.status === 'string' && row.status) metadata.conversation_status = row.status;
  if (Object.keys(metadata).length > 0) evidence.metadata = metadata;
  return evidence;
}

async function readJsonSafe<T>(target: string): Promise<T | undefined> {
  try {
    const { text } = await readTextLimited(target, 256 * 1024);
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

async function revisionCount(directory: string, filename: string): Promise<number> {
  try {
    const entries = await readdir(directory);
    return entries.filter((entry) => entry.startsWith(`${filename}.resolved`)).length;
  } catch {
    return 0;
  }
}

export class AntigravityAdapter implements AgentAdapter {
  readonly id = 'antigravity';
  readonly name = 'Google Antigravity';
  readonly version = '1.0.0';

  /** Cache of conversation_summaries.db rows, keyed by conversation id. */
  private summaries = new Map<string, Record<string, unknown>>();
  private summariesLoadedFor = new Set<string>();

  async discoverSources(options: DiscoverOptions = {}): Promise<AgentSource[]> {
    return discoverSources(SPEC, options);
  }

  async scanSessions(source: AgentSource): Promise<SessionReference[]> {
    const result = await scanJsonlSessions(source, {
      predicate: (relative) => {
        const parts = relative.split('/');
        return (
          parts.length === 3 &&
          parts[0] === 'brain' &&
          relative.endsWith('.md') &&
          !relative.includes('.resolved')
        );
      },
      nativeId: (relative) => conversationOf(relative) ?? relative,
      maxDepth: 6,
    });

    await this.loadConversationSummaries(source);
    const groups = new Map<string, SessionReference[]>();
    for (const session of result.sessions) {
      const conversation = session.native_session_id;
      const list = groups.get(conversation) ?? [];
      list.push(session);
      groups.set(conversation, list);
    }

    const sessions: SessionReference[] = [];
    for (const [conversation, files] of groups) {
      files.sort((a, b) => primaryFirst(a.relative_path) - primaryFirst(b.relative_path) ||
        a.relative_path.localeCompare(b.relative_path));
      const modified = files
        .map((file) => file.modified_at)
        .filter((value): value is string => typeof value === 'string')
        .sort()
        .pop();
      sessions.push({
        native_session_id: conversation,
        source,
        path: files[0]!.path,
        relative_path: files[0]!.relative_path,
        size_bytes: files.reduce((sum, file) => sum + file.size_bytes, 0),
        modified_at: modified,
        project_evidence: evidenceFromSummary(this.summaries.get(conversation)),
        incremental_unsafe: true,
        metadata: { artifacts: files.map((file) => file.relative_path).sort() },
      });
    }
    sessions.sort((a, b) => a.relative_path.localeCompare(b.relative_path));
    return sessions;
  }

  async parseSession(session: SessionReference): Promise<ParseResult> {
    const issues: ParseIssue[] = [];
    const artifacts = Array.isArray(session.metadata?.artifacts)
      ? (session.metadata!.artifacts as string[])
      : [session.relative_path];
    const descriptors: ArtifactDescriptor[] = [];

    for (const relative of artifacts) {
      const absolute = path.join(session.source.root, relative);
      const filename = path.basename(relative);
      const meta = await readJsonSafe<Record<string, unknown>>(`${absolute}.metadata.json`);
      const rawType = typeof meta?.artifactType === 'string' ? meta.artifactType : undefined;
      descriptors.push({
        relative,
        kind: artifactKind(rawType, filename),
        rawType,
        summary: typeof meta?.summary === 'string' ? meta.summary : undefined,
        updatedAt: typeof meta?.updatedAt === 'string' ? meta.updatedAt : undefined,
        revisionCount: await revisionCount(path.dirname(absolute), filename),
      });
    }
    descriptors.sort((a, b) =>
      ARTIFACT_ORDER.indexOf(a.kind) - ARTIFACT_ORDER.indexOf(b.kind) ||
      a.relative.localeCompare(b.relative));

    const records: ParseResult['records'] = [];
    let earliest: string | undefined;
    let latest: string | undefined;
    for (let index = 0; index < descriptors.length; index += 1) {
      const descriptor = descriptors[index]!;
      const absolute = path.join(session.source.root, descriptor.relative);
      let content: string;
      try {
        const read = await readTextLimited(absolute, MAX_ARTIFACT_BYTES);
        content = read.text.trim();
        if (read.truncated) {
          issues.push({ line: index + 1, reason: `${descriptor.relative} exceeds ${MAX_ARTIFACT_BYTES} bytes; content truncated` });
        }
      } catch (error) {
        issues.push({ line: index + 1, reason: `${descriptor.relative} could not be read: ${(error as Error).message}` });
        continue;
      }
      if (!content) {
        issues.push({ line: index + 1, reason: `${descriptor.relative} is empty; no event emitted` });
        continue;
      }

      const fallbackTime = await stat(absolute).then((value) => value.mtime.toISOString()).catch(() => undefined);
      const parsedTime = parseTimestamp(descriptor.updatedAt ?? fallbackTime);
      if (parsedTime.iso) {
        if (!earliest || parsedTime.iso < earliest) earliest = parsedTime.iso;
        if (!latest || parsedTime.iso > latest) latest = parsedTime.iso;
      }

      const completion = descriptor.kind === 'walkthrough';
      records.push({
        source_record_id: `${session.native_session_id}:${path.basename(descriptor.relative)}`,
        sequence: index,
        event_type: completion ? 'agent.execution.completed' : 'agent.message.recorded',
        occurred_at: parsedTime.iso,
        timestamp_precision: parsedTime.precision,
        role: 'assistant',
        content,
        execution_status: completion ? 'reported_walkthrough' : undefined,
        task_status: completion ? 'reported_walkthrough' : undefined,
        evidence_level: 'agent_reported',
        capture_level: 'derived',
        raw_type: `antigravity_${descriptor.kind}`,
        project_evidence: session.project_evidence,
        metadata: {
          artifact_path: descriptor.relative,
          artifact_type: descriptor.rawType ?? descriptor.kind,
          summary: descriptor.summary,
          updated_at: descriptor.updatedAt,
          resolved_revisions: String(descriptor.revisionCount),
        },
      });
    }

    return {
      records,
      issues,
      truncated: issues.some((issue) => issue.reason.includes('truncated')),
      session_started_at: earliest,
      session_ended_at: latest,
      project_evidence: session.project_evidence,
    };
  }

  getCapabilities(): AdapterCapabilities {
    return makeCapabilities({
      discovery: 'verified',
      session_listing: 'verified',
      task_status: 'partial',
      timestamps: 'partial',
      project_identity: 'partial',
      incremental_scan: 'partial',
      user_request: 'unavailable',
      ai_request: 'unavailable',
      agent_response: 'unavailable',
      tool_calls: 'unavailable',
      file_changes: 'unavailable',
      git_correlation: 'unavailable',
      formats: ['markdown', 'json'],
      verification: 'partially_verified',
      notes: [
        'Real local format observed: ~/.gemini/antigravity-ide/brain/<conversation-uuid>/<artifact>.md with sibling <artifact>.md.metadata.json and .resolved[.N] revisions.',
        'Each conversation directory is one session; task/plan/misc artifacts become agent.message.recorded and walkthrough becomes agent.execution.completed at agent_reported level.',
        'Raw conversations (conversations/*.pb, implicit/*.pb, user_settings.pb) are encrypted; they are counted in reports/unsupported-inventory.json and never parsed.',
        'Project identity is usually unavailable: workspace paths are only read from ~/.gemini/antigravity/conversation_summaries.db when that database has rows.',
        'Artifact metadata updatedAt is the event time; file mtime is only a fallback. Revisions are counted, not emitted as separate events.',
        'Sessions span multiple artifact files, so incremental reuse is disabled for this adapter.',
      ],
    });
  }

  private async loadConversationSummaries(source: AgentSource): Promise<void> {
    if (this.summariesLoadedFor.has(source.root)) return;
    this.summariesLoadedFor.add(source.root);
    const candidates = [
      path.join(source.root, 'conversation_summaries.db'),
      path.join(source.root, '..', 'antigravity', 'conversation_summaries.db'),
      path.join(source.root, '..', 'antigravity-ide', 'conversation_summaries.db'),
    ];
    for (const candidate of [...new Set(candidates)]) {
      const db = await openReadOnlySqlite(candidate);
      if (!db) continue;
      try {
        const rows = safeSqliteRows(db, 'SELECT * FROM conversation_summaries');
        for (const row of rows) {
          const id = row.conversation_id;
          if (typeof id === 'string' && id) this.summaries.set(id, row);
        }
      } finally {
        db.close();
      }
    }
  }
}
