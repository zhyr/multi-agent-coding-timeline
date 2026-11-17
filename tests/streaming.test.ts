import { describe, expect, it } from 'vitest';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readJsonl, writeJsonl } from '../src/core/jsonl.js';
import { hashFile } from '../src/core/hash.js';
import { tempDir } from './helpers/fixtures.js';

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
