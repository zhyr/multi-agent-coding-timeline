import { lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import { displayPath, inspectPath, walkFiles } from '../core/fs.js';
import { expandHome } from './util.js';
import type { AgentSource, DiscoverOptions, ProjectEvidence, SessionReference } from './types.js';

export interface DiscoverySpec {
  agentId: string;
  /** Absolute or ~/ relative candidate roots for automatic discovery. */
  defaultDirs: string[];
  format: string;
  /** Characteristic entries that identify this agent's data layout. */
  markers: string[];
  /** Common child names when an explicit source root contains several agents. */
  childNames?: string[];
}

function shortHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}

async function hasMarker(root: string, markers: string[]): Promise<boolean> {
  const { readdir } = await import('node:fs/promises');
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return false;
  }
  return markers.some((marker) => entries.includes(marker));
}

function makeSource(spec: DiscoverySpec, root: string, from: AgentSource['discovered_from'], layout: boolean): AgentSource {
  return {
    source_id: `${spec.agentId}-${shortHash(path.resolve(root))}`,
    agent_id: spec.agentId,
    root: path.resolve(root),
    display_path: displayPath(path.resolve(root)),
    format: spec.format,
    discovered_from: from,
    readable: true,
    metadata: { matched_layout: layout },
  };
}

/** Discover data roots automatically from well-known locations, or from explicit --source-root paths. */
export async function discoverSources(spec: DiscoverySpec, options: DiscoverOptions = {}): Promise<AgentSource[]> {
  const sources: AgentSource[] = [];
  if (options.roots && options.roots.length > 0) {
    for (const raw of options.roots) {
      const root = path.resolve(expandHome(raw));
      const info = await inspectPath(root);
      if (!info.exists || !info.isDirectory || !info.readable) {
        sources.push({
          ...makeSource(spec, root, 'explicit-root', false),
          readable: false,
          metadata: { matched_layout: false, reason: info.exists ? 'not readable' : 'missing' },
        });
        continue;
      }
      const candidates = [root, ...(spec.childNames ?? []).map((c) => path.join(root, c))];
      let matched = false;
      for (const candidate of candidates) {
        const candidateInfo = await inspectPath(candidate);
        if (!candidateInfo.exists || !candidateInfo.isDirectory || !candidateInfo.readable) continue;
        const layout = await hasMarker(candidate, spec.markers);
        const source = makeSource(spec, candidate, 'explicit-root', layout);
        if (layout) matched = true;
        sources.push(source);
        if (layout) break;
      }
      if (!matched) sources.push(makeSource(spec, root, 'explicit-root', false));
    }
    return dedupeSources(sources);
  }

  for (const raw of spec.defaultDirs) {
    const root = path.resolve(expandHome(raw));
    const info = await inspectPath(root);
    if (!info.exists || !info.isDirectory || !info.readable) continue;
    if (!(await hasMarker(root, spec.markers))) continue;
    sources.push(makeSource(spec, root, 'default', true));
  }
  return dedupeSources(sources);
}

function dedupeSources(sources: AgentSource[]): AgentSource[] {
  const seen = new Set<string>();
  return sources.filter((s) => {
    if (seen.has(s.root)) return false;
    seen.add(s.root);
    return true;
  });
}

export interface SessionScanSpec {
  predicate: (relativePath: string) => boolean;
  nativeId: (relativePath: string) => string;
  evidence?: (relativePath: string, source: AgentSource) => ProjectEvidence;
  maxDepth?: number;
  maxFiles?: number;
}

/** Enumerate session files inside a source root; symlinks are never followed. */
export async function scanJsonlSessions(
  source: AgentSource,
  spec: SessionScanSpec,
): Promise<{ sessions: SessionReference[]; skippedSymlinks: number; inaccessible: Array<{ path: string; reason: string }> }> {
  if (!source.readable) return { sessions: [], skippedSymlinks: 0, inaccessible: [] };
  const walked = await walkFiles(source.root, {
    maxDepth: spec.maxDepth ?? 9,
    maxFiles: spec.maxFiles ?? 20_000,
    predicate: (relative, isDirectory) => (isDirectory ? true : spec.predicate(relative)),
  });
  const sessions: SessionReference[] = [];
  for (const relative of walked.files) {
    const absolute = path.join(source.root, relative);
    let info;
    try {
      info = await stat(absolute);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    const evidence = spec.evidence?.(relative, source) ?? {};
    sessions.push({
      native_session_id: spec.nativeId(relative),
      source,
      path: absolute,
      relative_path: relative,
      size_bytes: info.size,
      modified_at: info.mtime.toISOString(),
      project_evidence: evidence,
      incomplete: relative.endsWith('.zst') ? false : undefined,
    });
  }
  sessions.sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  return {
    sessions,
    skippedSymlinks: walked.skippedSymlinks,
    inaccessible: walked.inaccessible,
  };
}

export async function isSymlink(target: string): Promise<boolean> {
  try {
    return (await lstat(target)).isSymbolicLink();
  } catch {
    return false;
  }
}
