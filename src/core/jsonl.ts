import { createReadStream, createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { IoError } from './errors.js';

export interface JsonlIssue {
  line: number;
  reason: string;
}

export interface JsonlReadResult<T> {
  records: T[];
  issues: JsonlIssue[];
  totalLines: number;
  truncated: boolean;
}

/** Safety ceiling only; real packages can legitimately exceed hundreds of MiB. */
const JSONL_DEFAULT_MAX_BYTES = 8 * 1024 * 1024 * 1024;

/**
 * Stream-parse JSONL defensively. Malformed / truncated lines are isolated and
 * reported, never silently promoted into events. Memory use is bounded by one
 * line at a time, not by the file size.
 */
export async function readJsonl<T = unknown>(
  target: string,
  options: { maxBytes?: number } = {},
): Promise<JsonlReadResult<T>> {
  const maxBytes = options.maxBytes ?? JSONL_DEFAULT_MAX_BYTES;
  const records: T[] = [];
  const issues: JsonlIssue[] = [];
  let totalLines = 0;
  let physicalLine = 0;
  let bytes = 0;
  let truncated = false;

  const stream = createReadStream(target, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      physicalLine += 1;
      bytes += Buffer.byteLength(line, 'utf8') + 1;
      if (bytes > maxBytes) {
        truncated = true;
        break;
      }
      if (!line.trim()) continue;
      totalLines += 1;
      try {
        records.push(JSON.parse(line) as T);
      } catch (error) {
        issues.push({ line: physicalLine, reason: error instanceof Error ? error.message : 'invalid JSON' });
      }
    }
  } catch (error) {
    throw new IoError(`Cannot read JSONL ${target}: ${(error as Error).message}`);
  } finally {
    lines.close();
    stream.destroy();
  }
  if (truncated) {
    issues.push({ line: physicalLine, reason: 'file exceeded read limit; tail not processed' });
  }
  return { records, issues, totalLines, truncated };
}

/** Stream JSONL to disk so large timelines never require one giant string. */
export async function writeJsonl(target: string, records: readonly unknown[]): Promise<void> {
  const stream = createWriteStream(target, { encoding: 'utf8' });
  try {
    for (const record of records) {
      if (!stream.write(`${JSON.stringify(record)}\n`)) await once(stream, 'drain');
    }
    stream.end();
    await once(stream, 'finish');
  } catch (error) {
    stream.destroy();
    throw new IoError(`Cannot write JSONL ${target}: ${(error as Error).message}`);
  }
}

export async function readJsonObject<T = unknown>(target: string): Promise<T> {
  try {
    return JSON.parse(await readFile(target, 'utf8')) as T;
  } catch (error) {
    throw new IoError(`Cannot parse JSON ${target}: ${(error as Error).message}`);
  }
}
