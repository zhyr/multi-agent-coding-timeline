import { access, lstat, readdir, readFile, stat, constants as fsConstants } from 'node:fs/promises';
import path from 'node:path';
import { IoError } from './errors.js';

export interface PathCheck {
  path: string;
  exists: boolean;
  readable: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
}

/** Inspect a path without ever modifying it. */
export async function inspectPath(target: string): Promise<PathCheck> {
  let linkStats;
  try {
    linkStats = await lstat(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { path: target, exists: false, readable: false, isDirectory: false, isSymlink: false };
    if (code === 'EACCES' || code === 'EPERM') return { path: target, exists: true, readable: false, isDirectory: false, isSymlink: false };
    throw new IoError(`Cannot inspect ${target}: ${(error as Error).message}`);
  }
  let readable = true;
  try {
    await access(target, fsConstants.R_OK);
  } catch {
    readable = false;
  }
  const st = await stat(target).catch(() => linkStats);
  return {
    path: target,
    exists: true,
    readable,
    isDirectory: st.isDirectory(),
    isSymlink: linkStats.isSymbolicLink(),
  };
}

export async function assertReadableDirectory(target: string, label = 'directory'): Promise<void> {
  const info = await inspectPath(target);
  if (!info.exists) throw new IoError(`${label} does not exist: ${target}`);
  if (!info.isDirectory) throw new IoError(`${label} is not a directory: ${target}`);
  if (!info.readable) throw new IoError(`${label} is not readable (permission denied): ${target}`);
}

export async function assertReadableFile(target: string, label = 'file'): Promise<void> {
  const info = await inspectPath(target);
  if (!info.exists) throw new IoError(`${label} does not exist: ${target}`);
  if (info.isDirectory) throw new IoError(`${label} is a directory, expected a file: ${target}`);
  if (!info.readable) throw new IoError(`${label} is not readable (permission denied): ${target}`);
}

/**
 * Full stat identity for an incremental fingerprint. `ctime` is included
 * because it changes on every write and cannot be back-dated from user space,
 * which makes it a useful last line of defence when a tool preserves mtime.
 */
export interface FileSignature {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  mtimeIso: string;
  ctimeIso: string;
}

export async function fileSignature(target: string): Promise<FileSignature> {
  const st = await stat(target);
  return {
    size: st.size,
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    ino: st.ino,
    mtimeIso: st.mtime.toISOString(),
    ctimeIso: st.ctime.toISOString(),
  };
}

/** True when two stat reads describe the same file state (size/time/inode). */
export function sameFileSignature(a: FileSignature, b: FileSignature): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino;
}

/** Resolve a candidate path and reject traversal outside `base`. */
export function resolveWithin(base: string, candidate: string): string {
  const root = path.resolve(base);
  const resolved = path.resolve(root, candidate);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new IoError(`Path traversal rejected: ${candidate} escapes ${root}`);
  }
  return resolved;
}

export function isWithin(base: string, candidate: string): boolean {
  try {
    resolveWithin(base, candidate);
    return true;
  } catch {
    return false;
  }
}

export interface WalkOptions {
  maxDepth?: number;
  maxFiles?: number;
  predicate?: (relativePath: string, isDirectory: boolean) => boolean;
  /** Symlinks are skipped by default, never followed. */
  followSymlinks?: boolean;
}

export interface WalkResult {
  files: string[];
  truncated: boolean;
  skippedSymlinks: number;
  inaccessible: Array<{ path: string; reason: string }>;
}

/**
 * Bounded, read-only recursive walk. Never follows symlinks by default and
 * records inaccessible directories instead of aborting a whole scan.
 */
export async function walkFiles(root: string, options: WalkOptions = {}): Promise<WalkResult> {
  const maxDepth = options.maxDepth ?? 8;
  const maxFiles = options.maxFiles ?? 20_000;
  const files: string[] = [];
  const inaccessible: WalkResult['inaccessible'] = [];
  let skippedSymlinks = 0;
  let truncated = false;

  async function recurse(dir: string, depth: number): Promise<void> {
    if (truncated || depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      inaccessible.push({ path: dir, reason: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' });
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        if (!options.followSymlinks) {
          skippedSymlinks += 1;
          continue;
        }
      }
      if (entry.isDirectory()) {
        if (!options.predicate || options.predicate(relative, true)) await recurse(absolute, depth + 1);
      } else if (entry.isFile()) {
        if (!options.predicate || options.predicate(relative, false)) files.push(relative);
      }
    }
  }

  await recurse(root, 0);
  files.sort();
  return { files, truncated, skippedSymlinks, inaccessible };
}

/** Read a text file with a hard byte cap. Source files are never written. */
export async function readTextLimited(
  target: string,
  maxBytes = 32 * 1024 * 1024,
): Promise<{ text: string; bytesRead: number; truncated: boolean }> {
  const handle = await import('node:fs/promises');
  const fh = await handle.open(target, 'r');
  try {
    const st = await fh.stat();
    const toRead = Math.min(st.size, maxBytes);
    const buffer = Buffer.alloc(toRead);
    const { bytesRead } = await fh.read(buffer, 0, toRead, 0);
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), bytesRead, truncated: st.size > maxBytes };
  } finally {
    await fh.close();
  }
}

export async function readJsonFile<T = unknown>(target: string): Promise<T> {
  try {
    return JSON.parse(await readFile(target, 'utf8')) as T;
  } catch (error) {
    throw new IoError(`Cannot parse JSON ${target}: ${(error as Error).message}`);
  }
}

/** Replace the home directory prefix in report output to avoid leaking absolute paths. */
export function displayPath(target: string): string {
  const home = process.env.HOME ?? '';
  if (home && target.startsWith(home)) return `~${target.slice(home.length)}`;
  return target;
}
