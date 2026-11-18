/**
 * Repository discovery for the interactive web app.
 *
 * Read-only: walks configured roots for git working trees and reads each
 * repository's latest commit time via the audited read-only git runner.
 * Never writes to, or executes hooks in, any discovered repository.
 */
import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runGit } from '../git/git-cli.js';

/** One discovered repository in the catalog. */
export interface RepositoryEntry {
  /** Stable id derived from the canonical path. */
  id: string;
  /** Repository folder name. */
  name: string;
  /** Canonical absolute working-tree path. */
  path: string;
  /** Origin remote URL, if any. */
  remote?: string;
  /** Latest commit time across all refs (ISO-8601), or undefined if no commits. */
  latestCommitAt?: string;
  /** Subject of the latest commit. */
  latestCommitSubject?: string;
  /** Short sha of the latest commit. */
  latestCommitSha?: string;
  /** Whether this entry has been scanned into a Timeline Package. */
  scanned: boolean;
  /** Event count from the last scan, if scanned. */
  eventCount?: number;
  /** Last scan completion time. */
  lastScannedAt?: string;
  /** Reason this repository could not be inspected. */
  error?: string;
}

export interface DiscoveryOptions {
  /** Roots to walk for git repositories. */
  roots: string[];
  /** Max directory depth to walk below each root. */
  maxDepth?: number;
  /** Optional case-insensitive filter applied to repository name and path. */
  keyword?: string;
  /** Progress callback. */
  onProgress?: (done: number, total: number, message: string) => void;
}

/** Default scan roots: the user's work directory. */
export function defaultScanRoots(): string[] {
  return [path.join(os.homedir(), 'work')];
}

/** Stable, path-derived project id (no randomness) so catalog entries persist. */
export function repoIdFromPath(repoPath: string): string {
  // FNV-1a over the normalized path, hex, prefixed for readability.
  let h = 0x811c9dc5;
  const normalized = path.resolve(repoPath).toLowerCase();
  for (let i = 0; i < normalized.length; i += 1) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `repo_${(h >>> 0).toString(16).padStart(8, '0')}`;
}

async function walkForGitDirs(
  root: string,
  maxDepth: number,
  onDir?: (dir: string) => void,
): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>();

  async function visit(dir: string, depth: number): Promise<void> {
    let canonical: string;
    try {
      canonical = await realpath(dir);
    } catch {
      return;
    }
    if (seen.has(canonical)) return;
    seen.add(canonical);
    onDir?.(canonical);

    // A directory is a repository if it has a .git entry (dir or worktree file).
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(canonical, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === '.git')) {
      found.push(canonical);
      return; // do not descend into nested repos of a repo
    }
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const name = e.name;
      if (name === 'node_modules' || name === '.git' || name === 'dist' ||
          name === 'build' || name === 'vendor' || name === '.cache' ||
          name === 'Library' || name === '.next' || name === 'coverage') continue;
      await visit(path.join(canonical, name), depth + 1);
    }
  }

  await visit(root, 0);
  return found;
}

/** Read latest-commit metadata for one repository using read-only git. */
export async function inspectRepository(repoPath: string): Promise<{
  remote?: string;
  latestCommitAt?: string;
  latestCommitSubject?: string;
  latestCommitSha?: string;
  error?: string;
}> {
  const top = await runGit(repoPath, ['rev-parse', '--show-toplevel']);
  const cwd = top.ok ? top.stdout.trim() : repoPath;

  const [remoteRes, logRes] = await Promise.all([
    runGit(cwd, ['remote', 'get-url', 'origin']),
    runGit(cwd, ['log', '-1', '--format=%H%x1f%cI%x1f%s']),
  ]);

  const remote = remoteRes.ok && remoteRes.stdout.trim() ? remoteRes.stdout.trim() : undefined;
  let latestCommitAt: string | undefined;
  let latestCommitSha: string | undefined;
  let latestCommitSubject: string | undefined;
  let error: string | undefined;

  if (logRes.ok && logRes.stdout.trim()) {
    const parts = logRes.stdout.trim().split('\x1f');
    if (parts.length >= 3) {
      latestCommitSha = parts[0]?.trim();
      latestCommitAt = parts[1]?.trim();
      latestCommitSubject = parts.slice(2).join('\x1f').trim();
    }
  } else if (!logRes.ok && /does not have any commits|ambiguous argument 'HEAD'/i.test(logRes.stderr)) {
    // Empty repository is valid; no error.
  } else if (!logRes.ok) {
    error = logRes.stderr.trim().slice(0, 300) || 'git log failed';
  }

  return { remote, latestCommitAt, latestCommitSha, latestCommitSubject, error };
}

/** Discover all repositories under the given roots, sorted by latest commit time desc. */
export async function discoverRepositories(options: DiscoveryOptions): Promise<RepositoryEntry[]> {
  const maxDepth = options.maxDepth ?? 3;
  const keyword = options.keyword?.trim().toLowerCase() ?? '';

  const dirsByRoot = await Promise.all(
    options.roots.map((root) => walkForGitDirs(root, maxDepth)),
  );
  const allDirs = [...new Set(dirsByRoot.flat())].sort((a, b) => a.localeCompare(b));

  const entries: RepositoryEntry[] = [];
  for (let i = 0; i < allDirs.length; i += 1) {
    const dir = allDirs[i];
    options.onProgress?.(i + 1, allDirs.length, `读取仓库 ${path.basename(dir)}`);
    const info = await inspectRepository(dir);
    entries.push({
      id: repoIdFromPath(dir),
      name: path.basename(dir),
      path: dir,
      remote: info.remote,
      latestCommitAt: info.latestCommitAt,
      latestCommitSha: info.latestCommitSha,
      latestCommitSubject: info.latestCommitSubject,
      scanned: false,
      error: info.error,
    });
  }

  const filtered = keyword
    ? entries.filter((e) => e.name.toLowerCase().includes(keyword) || e.path.toLowerCase().includes(keyword))
    : entries;

  // Latest commit first; entries without a commit go last, then by name.
  filtered.sort((a, b) => {
    if (a.latestCommitAt && b.latestCommitAt) {
      const cmp = b.latestCommitAt.localeCompare(a.latestCommitAt);
      if (cmp !== 0) return cmp;
    } else if (a.latestCommitAt) return -1;
    else if (b.latestCommitAt) return 1;
    return a.name.localeCompare(b.name);
  });

  return filtered;
}
