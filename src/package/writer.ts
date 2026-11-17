import { mkdir, readdir, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { IoError } from '../core/errors.js';
import { writeJsonl } from '../core/jsonl.js';
import type { TimelineData } from './model.js';
import { type ChecksumEntry, computeChecksums, writeChecksums } from './integrity.js';

export interface WriteResult {
  files: string[];
  checksums: ChecksumEntry[];
}

async function writeJson(target: string, value: unknown): Promise<void> {
  await writeFile(target, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function ensureSafeOutput(root: string, overwrite: boolean): Promise<void> {
  let stats;
  try {
    stats = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new IoError(`Cannot inspect output path ${root}: ${(error as Error).message}`);
  }
  if (stats.isSymbolicLink()) {
    throw new IoError(`Output path is a symlink and will not be written: ${root}`);
  }
  if (!stats.isDirectory()) {
    throw new IoError(`Output path exists and is not a directory: ${root}`);
  }
  const existing = await readdir(root);
  if (existing.length > 0 && !overwrite) {
    throw new IoError(
      `Output directory is not empty: ${root}. Use --force to replace it, or choose a new path.`,
    );
  }
}

/**
 * Write a complete Timeline Package. Everything inside `root` is generated;
 * no source file is ever copied here, only normalized records and references.
 */
export async function writePackage(
  root: string,
  data: TimelineData,
  options: { overwrite?: boolean } = {},
): Promise<WriteResult> {
  await ensureSafeOutput(root, options.overwrite ?? false);
  const absolute = path.resolve(root);
  for (const sub of ['git', 'sources', 'reports', 'integrity']) {
    await mkdir(path.join(absolute, sub), { recursive: true });
  }

  const files: string[] = [];
  const record = async (relative: string, content: string): Promise<void> => {
    const target = path.join(absolute, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
    files.push(relative);
  };
  const json = async (relative: string, value: unknown): Promise<void> => {
    await record(relative, JSON.stringify(value, null, 2) + '\n');
  };
  const jsonl = async (relative: string, values: readonly unknown[]): Promise<void> => {
    const target = path.join(absolute, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeJsonl(target, values);
    files.push(relative);
  };

  await json('manifest.json', data.manifest);
  await json('project.json', data.project);
  await json('devices.json', data.devices);
  await json('agents.json', data.agents);
  await jsonl('sessions.jsonl', data.sessions);
  await jsonl('tasks.jsonl', data.tasks);
  await jsonl('events.jsonl', data.events);
  await jsonl('relations.jsonl', data.relations);
  await jsonl('git/commits.jsonl', data.commits);
  await jsonl('git/pushes.jsonl', data.pushes);
  await jsonl('sources/source-index.jsonl', data.sources);
  if (data.scanInputs) await json('sources/scan-inputs.json', data.scanInputs);
  if (data.scanReport) await json('reports/scan-report.json', data.scanReport);
  if (data.mergeReport) await json('reports/merge-report.json', data.mergeReport);
  await jsonl('reports/conflicts.jsonl', data.conflicts);

  const computed = await computeChecksums(absolute);
  const checksums = await writeChecksums(absolute, computed);
  files.push('integrity/checksums.sha256');
  return { files: files.sort(), checksums };
}

export { writeJson };
