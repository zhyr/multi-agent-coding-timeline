import { mkdir, readdir, writeFile, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
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

/**
 * A Timeline Package directory is entirely tool-generated. Replacing one with
 * --force must therefore:
 *   - reject symlinks anywhere at the top level (writing through `git/` or
 *     `reports/` would escape the package),
 *   - remove stale files from the previous operation (e.g. a scan report left
 *     behind when the same directory is reused for a merge),
 *   - refuse to delete a directory that does not look like an existing package.
 */
async function ensureSafeOutput(root: string, overwrite: boolean): Promise<void> {
  const absolute = path.resolve(root);
  const protectedPaths = new Set([path.parse(absolute).root, homedir(), process.cwd()]);
  if (protectedPaths.has(absolute)) {
    throw new IoError(`Refusing to replace a protected path: ${absolute}`);
  }
  let stats;
  try {
    stats = await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new IoError(`Cannot inspect output path ${absolute}: ${(error as Error).message}`);
  }
  if (stats.isSymbolicLink()) {
    throw new IoError(`Output path is a symlink and will not be written: ${absolute}`);
  }
  if (!stats.isDirectory()) {
    throw new IoError(`Output path exists and is not a directory: ${absolute}`);
  }
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new IoError(
        `Output directory contains a symlink (${entry.name}); refusing to write through it: ${absolute}`,
      );
    }
  }
  const existing = await readdir(absolute);
  if (existing.length === 0) return;
  if (!overwrite) {
    throw new IoError(
      `Output directory is not empty: ${absolute}. Use --force to replace it, or choose a new path.`,
    );
  }
  if (!existing.includes('manifest.json')) {
    throw new IoError(
      `Refusing to replace a non-empty directory that is not an existing Timeline Package: ${absolute}`,
    );
  }
  // Replace the whole package so no file from the previous operation survives.
  await rm(absolute, { recursive: true, force: true });
  await mkdir(absolute, { recursive: true });
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

  // Adapter-contributed files (Cursor composer index, per-agent audit). Paths
  // are constrained to sources/ or reports/ so an adapter can never write into
  // git/, integrity/ or outside the package.
  for (const extra of data.supplemental ?? []) {
    const relative = extra.path.replace(/\\/g, '/');
    if (!/^(sources|reports)\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(relative)) {
      throw new IoError(`Adapter supplemental file path is not allowed: ${extra.path}`);
    }
    if (extra.format === 'jsonl') {
      if (!Array.isArray(extra.content)) {
        throw new IoError(`Adapter supplemental JSONL file must be an array: ${extra.path}`);
      }
      await jsonl(relative, extra.content);
    } else {
      await json(relative, extra.content);
    }
  }

  const computed = await computeChecksums(absolute);
  const checksums = await writeChecksums(absolute, computed);
  files.push('integrity/checksums.sha256');
  return { files: files.sort(), checksums };
}

export { writeJson };
