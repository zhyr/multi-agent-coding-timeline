import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileSignature, sameFileSignature } from '../core/fs.js';
import { hashFileBounded } from '../core/hash.js';

/**
 * Files larger than this are not content-hashed (typically editor SQLite
 * metadata databases). Their cursor falls back to a stat-only fingerprint that
 * requires both ctime and inode to match; ctime cannot be back-dated from user
 * space, so a same-size / same-mtime rewrite still invalidates the cursor.
 * Session transcripts are normally far below this ceiling and always get a
 * real SHA-256 content fingerprint.
 */
export const CONTENT_HASH_LIMIT_BYTES = 64 * 1024 * 1024;

export interface FileCursor {
  size_bytes: number;
  modified_at: string;
  /** SHA-256 of the file content at the last successful parse. */
  sha256?: string;
  /**
   * Which fingerprint produced this cursor. `sha256` is a content hash;
   * `stat` means the file exceeded CONTENT_HASH_LIMIT_BYTES and only the stat
   * identity is recorded. Absent on legacy cursors, which are re-parsed once.
   */
  fingerprint_kind?: 'sha256' | 'stat';
  /** ctime/inode at the last successful parse (stat-only fallback evidence). */
  ctime_at?: string;
  inode?: number;
  record_count: number;
  source_path_identity: string;
  agent_id: string;
  source_device_id: string;
}

export interface ScanState {
  version: 1;
  updated_at: string;
  files: Record<string, FileCursor>;
}

export function stateFileFor(stateDir: string, projectId: string): string {
  return path.join(stateDir, `${projectId}.state.json`);
}

export async function loadScanState(stateDir: string, projectId: string): Promise<ScanState> {
  const empty: ScanState = { version: 1, updated_at: new Date(0).toISOString(), files: {} };
  try {
    const parsed = JSON.parse(await readFile(stateFileFor(stateDir, projectId), 'utf8')) as ScanState;
    if (parsed.version !== 1 || typeof parsed.files !== 'object') return empty;
    return parsed;
  } catch {
    return empty;
  }
}

export async function saveScanState(stateDir: string, projectId: string, state: ScanState): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(stateFileFor(stateDir, projectId), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export function stateKey(sourceDeviceId: string, agentId: string, relativePath: string): string {
  return `${sourceDeviceId}:${agentId}:${relativePath}`;
}

/**
 * Metadata-only check retained for callers that cannot read the file. It must
 * NOT be used to decide incremental reuse: equal size + mtime is not proof of
 * equal content. Use `verifyCursor` for that decision.
 */
export function isUnchanged(
  state: ScanState,
  key: string,
  sizeBytes: number,
  modifiedAt: string | undefined,
): boolean {
  const cursor = state.files[key];
  if (!cursor || !modifiedAt) return false;
  return cursor.size_bytes === sizeBytes && cursor.modified_at === modifiedAt;
}

export type CursorCheckStatus = 'unchanged' | 'changed' | 'unstable';

export interface CursorCheck {
  status: CursorCheckStatus;
  /** Human-readable reason, safe to put in a scan warning (no absolute path). */
  reason: string;
  sha256?: string;
}

/**
 * Verify that a cursor still describes the current file content.
 *
 * Layered check:
 *   1. listing size + mtime must match the cursor;
 *   2. a fresh stat must match the listing (catches stale directory walks);
 *   3. small/medium files must match their SHA-256 content hash;
 *   4. huge files fall back to ctime + inode + size.
 *
 * A file that changes while it is being hashed is reported as `unstable` and
 * must not be committed to the next state.
 */
export async function verifyCursor(
  cursor: FileCursor,
  target: string,
  sizeBytes: number,
  modifiedAt: string | undefined,
): Promise<CursorCheck> {
  if (!modifiedAt) return { status: 'changed', reason: 'no modification time available' };
  if (cursor.size_bytes !== sizeBytes || cursor.modified_at !== modifiedAt) {
    return { status: 'changed', reason: 'size or mtime differs from cursor' };
  }

  let before;
  try {
    before = await fileSignature(target);
  } catch {
    return { status: 'changed', reason: 'file is no longer readable' };
  }
  if (before.size !== sizeBytes || before.mtimeIso !== modifiedAt) {
    return { status: 'changed', reason: 'stat differs from directory listing' };
  }

  if (cursor.fingerprint_kind === 'stat' && cursor.ctime_at && cursor.inode !== undefined) {
    return cursor.ctime_at === before.ctimeIso && cursor.inode === before.ino
      ? { status: 'unchanged', reason: 'large-file stat identity unchanged' }
      : { status: 'changed', reason: 'ctime or inode changed' };
  }

  if (!cursor.sha256) {
    return { status: 'changed', reason: 'legacy cursor has no content fingerprint; re-parsing once' };
  }

  let hashed;
  try {
    hashed = await hashFileBounded(target, CONTENT_HASH_LIMIT_BYTES);
  } catch {
    return { status: 'changed', reason: 'content could not be hashed' };
  }
  let after;
  try {
    after = await fileSignature(target);
  } catch {
    return { status: 'changed', reason: 'file disappeared while hashing' };
  }
  if (!sameFileSignature(before, after)) {
    return { status: 'unstable', reason: 'file changed while hashing; reuse deferred' };
  }
  if (hashed.exceeded) {
    return { status: 'changed', reason: 'file now exceeds the content-hash ceiling' };
  }
  return hashed.sha256 === cursor.sha256
    ? { status: 'unchanged', reason: 'size, mtime and SHA-256 match', sha256: hashed.sha256 }
    : { status: 'changed', reason: 'content hash differs from cursor' };
}
