import { describe, expect, it } from 'vitest';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readJsonl, writeJsonl } from '../src/core/jsonl.js';
import { hashFile } from '../src/core/hash.js';
import { decompressBounded, parseLines, readSessionText } from '../src/adapters/util.js';
import * as zlib from 'node:zlib';
import { tempDir } from './helpers/fixtures.js';

const zstdCompress = (zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync;

/**
 * Regression guard for the 64 MiB JSONL ceiling that used to truncate large
 * Timeline Packages (a real 237 MiB package failed self-validation). The file
 * here is deliberately larger than the old limit.
 */
describe('streaming JSONL above the old 64 MiB limit', () => {
  it('writes, reads and hashes a >64 MiB JSONL file without truncation', async () => {
    const root = await tempDir('aitimeline-large-');
    const file = path.join(root, 'events.jsonl');
    const payload = 'x'.repeat(900);
    const count = 70_000;
    const records = Array.from({ length: count }, (_, i) => ({ n: i, payload }));
    await writeJsonl(file, records);

    const read = await readJsonl<{ n: number; payload: string }>(file);
    expect(read.truncated).toBe(false);
    expect(read.issues).toEqual([]);
    expect(read.totalLines).toBe(count);
    expect(read.records).toHaveLength(count);
    expect(read.records[0]!.n).toBe(0);
    expect(read.records[count - 1]!.n).toBe(count - 1);
    expect(read.records[0]!.payload.length).toBe(900);

    const hashed = await hashFile(file);
    const expected = await new Promise<string>((resolve, reject) => {
      const hash = createHash('sha256');
      createReadStream(file)
        .on('data', (chunk) => hash.update(chunk))
        .on('error', reject)
        .on('end', () => resolve(hash.digest('hex')));
    });
    expect(hashed).toBe(expected);
  }, 120_000);

  it('reports truncation explicitly when an explicit byte limit is exceeded', async () => {
    const root = await tempDir('aitimeline-large-limit-');
    const file = path.join(root, 'events.jsonl');
    await writeJsonl(
      file,
      Array.from({ length: 5_000 }, (_, i) => ({ n: i, payload: 'y'.repeat(600) })),
    );
    const read = await readJsonl(file, { maxBytes: 1_000_000 });
    expect(read.truncated).toBe(true);
    expect(read.records.length).toBeGreaterThan(0);
    expect(read.records.length).toBeLessThan(5_000);
    expect(read.issues.some((issue) => issue.reason.includes('exceeded read limit'))).toBe(true);
  }, 60_000);
});

/**
 * Regression guard for real Codex archives whose decompressed size exceeds the
 * 64 MiB bound: the synchronous path used to throw and discard every record.
 * The caps here are small so the fallback is exercised without huge fixtures.
 */
describe('bounded zstd decompression', () => {
  const text = Array.from({ length: 400 }, (_, i) =>
    JSON.stringify({ type: 'response_item', n: i, payload: 'z'.repeat(120) }),
  ).join('\n') + '\n';

  it.skipIf(!zstdCompress)('keeps the readable prefix when output exceeds the sync bound', async () => {
    const raw = zstdCompress!(Buffer.from(text, 'utf8'));
    const bounded = await decompressBounded(raw, 1024, 3000);
    expect(bounded.truncated).toBe(true);
    expect(bounded.issues).toEqual([]);
    expect(bounded.buffer.length).toBeLessThanOrEqual(3000);
    expect(bounded.buffer[bounded.buffer.length - 1]).toBe(0x0a);
    const issues: { line: number; reason: string }[] = [];
    const records = parseLines<{ n: number }>(bounded.buffer.toString('utf8'), issues);
    expect(records.length).toBeGreaterThan(0);
    expect(records[0]!.n).toBe(0);
    expect(issues.filter((issue) => issue.reason.includes('Unterminated'))).toEqual([]);
  });

  it.skipIf(!zstdCompress)('returns the complete text when it fits the bound', async () => {
    const raw = zstdCompress!(Buffer.from(text, 'utf8'));
    const full = await decompressBounded(raw, 1024 * 1024, 1024 * 1024);
    expect(full.truncated).toBe(false);
    expect(full.issues).toEqual([]);
    expect(full.buffer.toString('utf8')).toBe(text);
  });

  it('drops a partial trailing record when a session hits the byte limit', async () => {
    const root = await tempDir('aitimeline-trunc-line-');
    const file = path.join(root, 'rollout-big.jsonl');
    await writeJsonl(
      file,
      Array.from({ length: 29_000 }, (_, n) => ({ n, payload: 'q'.repeat(900) })),
    );
    const read = await readSessionText(
      { path: file, native_session_id: 'sess-big' } as unknown as Parameters<typeof readSessionText>[0],
    );
    expect(read.truncated).toBe(true);
    expect(read.issues.some((issue) => issue.reason.includes('tail not processed'))).toBe(true);
    expect(read.text.endsWith('\n')).toBe(true);
    const parseIssues: { line: number; reason: string }[] = [];
    const records = parseLines<{ n: number }>(read.text, parseIssues);
    expect(records.length).toBeGreaterThan(10_000);
    expect(parseIssues).toEqual([]);
  }, 60_000);
});
