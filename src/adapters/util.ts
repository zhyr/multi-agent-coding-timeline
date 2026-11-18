import { open } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import type { ParseIssue, SessionReference, TimestampPrecision } from './types.js';

export const MAX_SESSION_BYTES = 24 * 1024 * 1024;
export const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

export function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return path.join(homedir(), input.slice(2));
  return input;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Read at most `limit` bytes without ever allocating a buffer for the whole
 * file. Large agent archives must not be able to exhaust process memory.
 */
async function readBounded(filePath: string, limit: number): Promise<{ buffer: Buffer; truncated: boolean }> {
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, limit);
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    return { buffer: buffer.subarray(0, offset), truncated: size > limit };
  } finally {
    await handle.close();
  }
}

/** Read session text with an explicit byte bound; `.zst` rollouts are decompressed in memory, never extracted to disk. */
export async function readSessionText(
  session: SessionReference,
): Promise<{ text: string; truncated: boolean; issues: ParseIssue[] }> {
  const issues: ParseIssue[] = [];
  const isZst = session.path.endsWith('.zst');
  const limit = isZst ? MAX_DECOMPRESSED_BYTES : MAX_SESSION_BYTES;
  const { buffer: raw, truncated: inputTruncated } = await readBounded(session.path, limit);
  if (isZst && inputTruncated) {
    return {
      text: '',
      truncated: true,
      issues: [
        {
          line: 0,
          reason: `compressed session exceeds ${MAX_DECOMPRESSED_BYTES} byte read limit; a partial zstd frame cannot be safely decompressed`,
        },
      ],
    };
  }
  let buffer: Buffer = raw;
  if (isZst) {
    try {
      const zlib = await import('node:zlib');
      const zstd = (zlib as unknown as { zstdDecompressSync?: (b: Buffer, o?: { maxOutputLength?: number }) => Buffer })
        .zstdDecompressSync;
      if (!zstd) throw new Error('this Node build has no zstd support');
      buffer = zstd(raw, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
    } catch (error) {
      return {
        text: '',
        truncated: true,
        issues: [{ line: 0, reason: `zstd decompression failed: ${(error as Error).message}` }],
      };
    }
  }
  const truncated = inputTruncated || buffer.length > MAX_SESSION_BYTES;
  const usable = buffer.length > MAX_SESSION_BYTES ? buffer.subarray(0, MAX_SESSION_BYTES) : buffer;
  if (truncated) issues.push({ line: 0, reason: 'session exceeds read limit; tail not processed' });
  return { text: usable.toString('utf8'), truncated, issues };
}

/** Parse a JSONL buffer, isolating malformed and truncated lines. */
export function parseLines<T = Record<string, unknown>>(
  text: string,
  issues: ParseIssue[],
): T[] {
  const lines = text.split('\n');
  const out: T[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as T;
      if (parsed === null || typeof parsed !== 'object') {
        issues.push({ line: i + 1, reason: 'record is not a JSON object' });
        continue;
      }
      out.push(parsed);
    } catch (error) {
      issues.push({ line: i + 1, reason: error instanceof Error ? error.message : 'invalid JSON' });
    }
  }
  // A non-newline-terminated tail is treated as a possibly incomplete record.
  if (lines.length > 0 && lines[lines.length - 1]!.trim() !== '') {
    issues.push({ line: lines.length, reason: 'file does not end with a newline; final record may be truncated' });
  }
  return out;
}

export function parseTimestamp(value: unknown): { iso?: string; precision: TimestampPrecision } {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return { precision: 'unknown' };
    return { iso: date.toISOString(), precision: 'millisecond' };
  }
  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return parseTimestamp(Number(trimmed));
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      const hasMs = /\.\d{3}/.test(trimmed);
      return { iso: new Date(parsed).toISOString(), precision: hasMs ? 'millisecond' : 'second' };
    }
  }
  return { precision: 'unknown' };
}

export interface TextBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  [key: string]: unknown;
}

export function toBlocks(content: unknown): TextBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is TextBlock => !!b && typeof b === 'object');
}

/**
 * Block types that carry plain text. OpenAI Codex rollouts use `input_text`
 * for user/developer content and `output_text` for assistant content; other
 * agents use `text`.
 */
const TEXT_BLOCK_TYPES = new Set(['text', 'input_text', 'output_text']);

/** Join all textual blocks. Non-text blocks (tool_use/tool_result/thinking) are returned separately. */
export function extractContent(content: unknown): { text: string; nonText: TextBlock[] } {
  const blocks = toBlocks(content);
  const texts: string[] = [];
  const nonText: TextBlock[] = [];
  for (const block of blocks) {
    const blockType = typeof block.type === 'string' ? block.type : '';
    if ((TEXT_BLOCK_TYPES.has(blockType) || blockType === '') && typeof block.text === 'string') {
      texts.push(block.text);
    } else {
      nonText.push(block);
    }
  }
  return { text: texts.join('\n').trim(), nonText };
}

export function stringifyUnknown(value: unknown, limit = 2000): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  try {
    const text = JSON.stringify(value);
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  } catch {
    return String(value);
  }
}

/** Qoder / Claude Code encode a working directory into a directory name. */
export function encodeProjectPath(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Best-effort reverse of encodeProjectPath. Marked heuristic; never used as exact evidence. */
export function decodeProjectPath(encoded: string): string {
  const cleaned = encoded.replace(/^-+/, '').replace(/-+$/, '');
  return '/' + cleaned.split('-').filter(Boolean).join('/');
}

/**
 * Open a SQLite database strictly read-only using Node's built-in module.
 * Returns null when the module is unavailable; the caller must then downgrade
 * capabilities rather than fabricate data. WAL files are read in place and
 * never copied (a live DB cannot be assumed to be a consistent snapshot).
 */
export async function openReadOnlySqlite(file: string): Promise<SqliteLike | null> {
  try {
    const mod = (await import('node:sqlite')) as unknown as {
      DatabaseSync?: new (p: string, o: { readOnly: boolean }) => SqliteLike;
    };
    if (!mod.DatabaseSync) return null;
    const db = new mod.DatabaseSync(file, { readOnly: true });
    db.exec?.('PRAGMA query_only = ON');
    return db;
  } catch {
    return null;
  }
}

export interface SqliteLike {
  prepare(sql: string): {
    all(...params: unknown[]): Array<Record<string, unknown>>;
  };
  exec?(sql: string): void;
  close(): void;
}

export function safeSqliteRows(
  db: SqliteLike,
  sql: string,
  onError?: (message: string) => void,
): Array<Record<string, unknown>> {
  try {
    return db.prepare(sql).all();
  } catch (error) {
    onError?.((error as Error).message);
    return [];
  }
}

/** Stable source identity relative to the scan root, so mount points do not change dedup keys. */
export function sourceIdentity(sourceRoot: string, absolutePath: string): string {
  const relative = path.relative(sourceRoot, absolutePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return path.basename(absolutePath);
  }
  return relative.split(path.sep).join('/');
}
