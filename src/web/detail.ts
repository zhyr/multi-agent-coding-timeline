/**
 * Detail-view data access with an in-memory model cache and page slicing.
 *
 * Large projects (e.g. an agent's whole rollout archive) can produce >100k
 * events. Building the ViewerModel is CPU-heavy and serialising all events to
 * the browser freezes the UI. This module builds + sanitizes the model once
 * per package version, then serves small, filtered pages to the UI.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { readPackage } from '../package/reader.js';
import { buildViewerModel, type ViewerModel, type ViewerEvent } from '../viewer/build.js';
import { sanitizeViewerModel } from './sanitize.js';
import { projectOutputDir } from './store.js';

interface CacheEntry {
  model: ViewerModel;
  signature: string;
}

const cache = new Map<string, CacheEntry>();

/** Cache signature: package events.jsonl mtime+size, so refreshed scans invalidate. */
async function packageSignature(outDir: string): Promise<string> {
  try {
    const s = await stat(path.join(outDir, 'events.jsonl'));
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return 'none';
  }
}

/** Load (and cache) the sanitized ViewerModel for a project id. */
export async function loadViewerModel(
  dataDir: string,
  projectId: string,
): Promise<{ model: ViewerModel; signature: string } | null> {
  const outDir = projectOutputDir(dataDir, projectId);
  const signature = await packageSignature(outDir);
  if (signature === 'none') return null;

  const cached = cache.get(projectId);
  if (cached && cached.signature === signature) {
    return { model: cached.model, signature };
  }

  const result = await readPackage(outDir);
  if (!result.data) return null;
  const model = sanitizeViewerModel(buildViewerModel(result.data));
  cache.set(projectId, { model, signature });
  return { model, signature };
}

export interface DetailQuery {
  q: string;
  type: string;
  evidence: string;
  agent: string;
  /** Raw device id (matches ViewerEvent.deviceId, which may include a scanner suffix). */
  device: string;
  /** Native/canonical session id (sess_...). */
  session: string;
  offset: number;
  limit: number;
}

/**
 * A conversation segment: all events sharing the same (session id, device, agent)
 * triple, rendered as one chronological list. This is the identity that keeps
 * parallel subagents and cross-device replays from being merged incorrectly.
 */
export interface SessionSegment {
  sessionId: string;
  deviceId: string;
  agentId: string;
  agentName: string;
  eventCount: number;
  firstAt: string;
  lastAt: string;
  firstTitle: string;
  evidence: string;
  incomplete: boolean;
}

export interface SegmentPage {
  segments: SessionSegment[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  signature: string;
}

export interface DetailPage {
  meta: ViewerModel['meta'];
  events: ViewerEvent[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  sessions: ViewerModel['sessions'];
  commits: ViewerModel['commits'];
  agents: ViewerModel['agents'];
  devices: ViewerModel['devices'];
  warnings: string[];
  reports: ViewerModel['reports'];
  signature: string;
}

function matches(
  event: ViewerEvent,
  q: string,
  type: string,
  evidence: string,
  agent: string,
  device: string,
  session: string,
): boolean {
  if (type && event.type !== type) return false;
  if (evidence && event.evidence !== evidence) return false;
  if (agent && event.agentId !== agent && event.agentName !== agent) return false;
  if (device && event.deviceId !== device) return false;
  if (session && event.sessionId !== session) return false;
  if (q) {
    const needle = q.toLowerCase();
    const hay = [
      event.title, event.body, event.type, event.agentName, event.deviceId,
      event.commit, event.branch, event.provenance?.sourcePath,
      (event.files ?? []).join(' '),
    ].join(' ').toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

/** Build a small page from the cached model. */
export function buildDetailPage(loaded: { model: ViewerModel; signature: string }, query: DetailQuery): DetailPage {
  const { model, signature } = loaded;
  const filtered = query.q || query.type || query.evidence || query.agent || query.device || query.session
    ? model.events.filter((e) =>
        matches(e, query.q, query.type, query.evidence, query.agent, query.device, query.session))
    : model.events;
  const offset = Math.max(0, Math.min(query.offset, filtered.length));
  const limit = Math.max(1, Math.min(query.limit, 500));
  const page = filtered.slice(offset, offset + limit);

  return {
    meta: model.meta,
    events: page,
    total: filtered.length,
    offset,
    limit,
    hasMore: offset + page.length < filtered.length,
    sessions: model.sessions,
    commits: model.commits,
    agents: model.agents,
    devices: model.devices,
    warnings: model.warnings,
    reports: model.reports,
    signature,
  };
}

/** Distinct event types for the filter dropdown, computed once from cached model. */
export function eventTypes(loaded: { model: ViewerModel }): string[] {
  return [...new Set(loaded.model.events.map((e) => e.type))].sort();
}

const segmentCache = new Map<string, { segments: SessionSegment[]; signature: string }>();

/**
 * Aggregate events into conversation segments keyed by (sessionId, deviceId, agentId).
 * Computed once per package version and cached; a 164k-event project must not be
 * regrouped on every request. Segments are ordered by last activity descending
 * so the most recent conversation appears first.
 */
function allSegments(loaded: { model: ViewerModel; signature: string }): SessionSegment[] {
  const { model, signature } = loaded;
  const cached = segmentCache.get(model.meta.projectId);
  if (cached && cached.signature === signature) return cached.segments;

  const groups = new Map<string, SessionSegment>();
  for (const e of model.events) {
    const key = `${e.sessionId ?? ''}\u0000${e.deviceId}\u0000${e.agentId}`;
    let seg = groups.get(key);
    if (!seg) {
      seg = {
        sessionId: e.sessionId ?? '',
        deviceId: e.deviceId,
        agentId: e.agentId,
        agentName: e.agentName || e.agentId,
        eventCount: 0,
        firstAt: e.at,
        lastAt: e.at,
        firstTitle: e.title,
        evidence: e.evidence,
        incomplete: false,
      };
      groups.set(key, seg);
    }
    seg.eventCount += 1;
    if (e.at && (!seg.firstAt || e.at < seg.firstAt)) seg.firstAt = e.at;
    if (e.at && (!seg.lastAt || e.at > seg.lastAt)) seg.lastAt = e.at;
  }

  const segments = [...groups.values()].sort(
    (a, b) => (b.lastAt || '').localeCompare(a.lastAt || '') || a.sessionId.localeCompare(b.sessionId),
  );
  segmentCache.set(model.meta.projectId, { segments, signature });
  return segments;
}

/**
 * A page of conversation segments for one dimension. Clicking Agent / device /
 * session in the event detail panel calls this with the corresponding filter,
 * producing a chronological list of every conversation for that value.
 */
export function sessionSegments(
  loaded: { model: ViewerModel; signature: string },
  query: DetailQuery,
): SegmentPage {
  const { signature } = loaded;
  const all = allSegments(loaded);
  const needle = query.q ? query.q.toLowerCase() : '';
  const filtered = all.filter((s) => {
    if (query.agent && s.agentId !== query.agent && s.agentName !== query.agent) return false;
    if (query.device && s.deviceId !== query.device) return false;
    if (query.session && s.sessionId !== query.session) return false;
    if (needle) {
      const hay = [s.sessionId, s.deviceId, s.agentId, s.agentName, s.firstTitle].join(' ').toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
  const offset = Math.max(0, Math.min(query.offset, filtered.length));
  const limit = Math.max(1, Math.min(query.limit, 500));
  const page = filtered.slice(offset, offset + limit);
  return {
    segments: page,
    total: filtered.length,
    offset,
    limit,
    hasMore: offset + page.length < filtered.length,
    signature,
  };
}

/** Distinct code agents actually present in the events, for the agent filter. */
export function agentOptions(loaded: { model: ViewerModel }): Array<{ id: string; name: string }> {
  const byId = new Map<string, string>();
  for (const e of loaded.model.events) {
    if (e.agentId) byId.set(e.agentId, e.agentName || e.agentId);
  }
  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
