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
  offset: number;
  limit: number;
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

function matches(event: ViewerEvent, q: string, type: string, evidence: string, agent: string): boolean {
  if (type && event.type !== type) return false;
  if (evidence && event.evidence !== evidence) return false;
  if (agent && event.agentId !== agent && event.agentName !== agent) return false;
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
  const filtered = query.q || query.type || query.evidence || query.agent
    ? model.events.filter((e) => matches(e, query.q, query.type, query.evidence, query.agent))
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
