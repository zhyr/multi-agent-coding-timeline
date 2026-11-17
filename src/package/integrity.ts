import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hashFile, sha256 } from '../core/hash.js';

export const CHECKSUMS_FILE = 'integrity/checksums.sha256';

export interface ChecksumEntry {
  path: string;
  hash: string;
}

export interface ChecksumVerification {
  ok: boolean;
  checked: number;
  missing: Array<{ path: string }>;
  mismatched: Array<{ path: string; expected: string; actual: string }>;
  unlisted: string[];
  errors: string[];
}

/** List every regular file in a package except the checksum manifest itself. */
export async function listPackageFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function recurse(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) await recurse(absolute);
      else if (entry.isFile() && relative !== CHECKSUMS_FILE) out.push(relative);
    }
  }
  await recurse(root);
  return out.sort();
}

export async function computeChecksums(root: string): Promise<ChecksumEntry[]> {
  const files = await listPackageFiles(root);
  const entries: ChecksumEntry[] = [];
  for (const relative of files) {
    entries.push({ path: relative, hash: await hashFile(path.join(root, relative)) });
  }
  return entries;
}

export function formatChecksums(entries: readonly ChecksumEntry[]): string {
  if (!entries.length) return '';
  return [...entries]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((e) => `${e.hash}  ${e.path}`)
    .join('\n') + '\n';
}

export async function writeChecksums(root: string, entries?: readonly ChecksumEntry[]): Promise<ChecksumEntry[]> {
  const resolved = entries ?? (await computeChecksums(root));
  const target = path.join(root, CHECKSUMS_FILE);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, formatChecksums(resolved), 'utf8');
  return [...resolved];
}

export function parseChecksums(text: string): ChecksumEntry[] {
  const out: ChecksumEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const match = /^([0-9a-f]{64})\s{2}(.+)$/i.exec(line);
    if (match) out.push({ hash: match[1]!.toLowerCase(), path: match[2]! });
  }
  return out;
}

export async function verifyChecksums(root: string): Promise<ChecksumVerification> {
  const result: ChecksumVerification = {
    ok: false,
    checked: 0,
    missing: [],
    mismatched: [],
    unlisted: [],
    errors: [],
  };
  const checksumPath = path.join(root, CHECKSUMS_FILE);
  let text: string;
  try {
    text = await readFile(checksumPath, 'utf8');
  } catch (error) {
    result.errors.push(`missing ${CHECKSUMS_FILE}: ${(error as Error).message}`);
    return result;
  }
  const listed = parseChecksums(text);
  if (!listed.length) {
    result.errors.push(`${CHECKSUMS_FILE} contains no valid entries`);
    return result;
  }
  const listedPaths = new Set(listed.map((e) => e.path));
  const actualFiles = await listPackageFiles(root);
  for (const file of actualFiles) {
    if (!listedPaths.has(file)) result.unlisted.push(file);
  }
  for (const entry of listed) {
    let actual: string;
    try {
      actual = await hashFile(path.join(root, entry.path));
    } catch {
      result.missing.push({ path: entry.path });
      continue;
    }
    result.checked += 1;
    if (actual !== entry.hash) result.mismatched.push({ path: entry.path, expected: entry.hash, actual });
  }
  result.ok =
    result.errors.length === 0 &&
    result.missing.length === 0 &&
    result.mismatched.length === 0 &&
    result.unlisted.length === 0;
  return result;
}

/** Convenience for tests and integrity of in-memory buffers. */
export function hashText(text: string): string {
  return sha256(text);
}
