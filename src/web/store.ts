/**
 * Local persistence for the interactive web app.
 *
 * All state lives under a user-owned data directory (default ~/.aitimeline-web).
 * Never writes into agent source directories or git working trees.
 */
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { RepositoryEntry } from './discovery.js';

export interface WebConfig {
  /** Roots scanned for git repositories. */
  roots: string[];
  /** Last keyword used (UI convenience, not required for scans). */
  lastKeyword?: string;
  /** Whether the scan uses full content or summary in level-2 scans. */
  contentMode: 'metadata_only' | 'summary' | 'full';
}

export interface Catalog {
  version: 1;
  updatedAt: string;
  config: WebConfig;
  repositories: RepositoryEntry[];
}

export function defaultDataDir(): string {
  return path.join(os.homedir(), '.aitimeline-web');
}

export function defaultConfig(): WebConfig {
  return { roots: [path.join(os.homedir(), 'work')], contentMode: 'summary' };
}

function catalogPath(dataDir: string): string {
  return path.join(dataDir, 'catalog.json');
}

export function projectsDir(dataDir: string): string {
  return path.join(dataDir, 'projects');
}

export function stateDir(dataDir: string): string {
  return path.join(dataDir, 'state');
}

/** Catalog ids are opaque and must never contain path separators. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function assertSafeProjectId(projectId: string): string {
  if (!SAFE_ID.test(projectId)) throw new Error('invalid project id');
  return projectId;
}

export function projectOutputDir(dataDir: string, projectId: string): string {
  return path.join(projectsDir(dataDir), assertSafeProjectId(projectId));
}

export async function ensureLayout(dataDir: string): Promise<void> {
  await mkdir(projectsDir(dataDir), { recursive: true });
  await mkdir(stateDir(dataDir), { recursive: true });
}

export async function loadConfig(dataDir: string): Promise<WebConfig> {
  try {
    const raw = await readFile(catalogPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as Catalog;
    if (parsed?.config && Array.isArray(parsed.config.roots)) return parsed.config;
  } catch {
    // fall through to default
  }
  return defaultConfig();
}

export async function saveConfig(dataDir: string, config: WebConfig): Promise<void> {
  await ensureLayout(dataDir);
  let catalog = await loadCatalog(dataDir);
  if (!catalog) {
    catalog = { version: 1, updatedAt: new Date().toISOString(), config, repositories: [] };
  } else {
    catalog.config = config;
    catalog.updatedAt = new Date().toISOString();
  }
  await writeFile(catalogPath(dataDir), JSON.stringify(catalog, null, 2) + '\n', 'utf8');
}

export async function loadCatalog(dataDir: string): Promise<Catalog | null> {
  try {
    const raw = await readFile(catalogPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as Catalog;
    if (parsed?.version === 1 && Array.isArray(parsed.repositories)) return parsed;
  } catch {
    // no catalog yet
  }
  return null;
}

/**
 * Persist a discovered repository list, preserving scan metadata (scanned flag,
 * event count, last scan time) for entries that still exist.
 */
export async function saveDiscoveredRepositories(
  dataDir: string,
  repositories: RepositoryEntry[],
  config: WebConfig,
): Promise<Catalog> {
  await ensureLayout(dataDir);
  const prior = await loadCatalog(dataDir);
  const priorById = new Map((prior?.repositories ?? []).map((r) => [r.id, r]));

  const merged = repositories.map((r) => {
    const old = priorById.get(r.id);
    return {
      ...r,
      scanned: old?.scanned ?? false,
      eventCount: old?.eventCount,
      lastScannedAt: old?.lastScannedAt,
    };
  });

  const catalog: Catalog = {
    version: 1,
    updatedAt: new Date().toISOString(),
    config,
    repositories: merged,
  };
  await writeFile(catalogPath(dataDir), JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  return catalog;
}

/** Mark a repository as scanned with its event count. */
export async function markScanned(
  dataDir: string,
  projectId: string,
  eventCount: number,
): Promise<Catalog | null> {
  const catalog = await loadCatalog(dataDir);
  if (!catalog) return null;
  const entry = catalog.repositories.find((r) => r.id === projectId);
  if (entry) {
    entry.scanned = true;
    entry.eventCount = eventCount;
    entry.lastScannedAt = new Date().toISOString();
    catalog.updatedAt = new Date().toISOString();
    await writeFile(catalogPath(dataDir), JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  }
  return catalog;
}

/** Check whether a Timeline Package exists for a project id. */
export async function hasPackage(dataDir: string, projectId: string): Promise<boolean> {
  try {
    const files = await readdir(projectOutputDir(dataDir, projectId));
    return files.includes('manifest.json') && files.includes('events.jsonl');
  } catch {
    return false;
  }
}
