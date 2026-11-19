/**
 * Per-project export for the interactive web app.
 *
 * Two formats:
 *  - jsonl: the sanitized events as newline-delimited JSON (streamed, no zip deps)
 *  - zip:    the complete Timeline Package directory, via a read-only shell-out
 *            to `zip` (source package is never modified)
 */
import { createReadStream } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { projectOutputDir } from './store.js';
import { mentionsBlocked } from './sanitize.js';

const execFileAsync = promisify(execFile);

export type ExportFormat = 'jsonl' | 'zip';

/** Read just the project name from the small project.json (avoids loading 100k+ events). */
async function projectNameOf(src: string, fallback: string): Promise<string> {
  try {
    const p = JSON.parse(await readFile(path.join(src, 'project.json'), 'utf8')) as { project_name?: string };
    return p.project_name || fallback;
  } catch {
    return fallback;
  }
}

/** Sanitize JSONL: rebuild from the (already validated + sanitized) viewer model's source events.
 *  We stream the raw package file but drop any line mentioning a blocked path token. */
export async function exportJsonl(
  dataDir: string,
  projectId: string,
): Promise<{ stream: NodeJS.ReadableStream; filename: string } | null> {
  const file = path.join(projectOutputDir(dataDir, projectId), 'events.jsonl');
  try {
    await stat(file);
  } catch {
    return null;
  }
  const projectName = await projectNameOf(projectOutputDir(dataDir, projectId), projectId);
  // Note: line-level sanitization is applied by the streaming transform in server.ts.
  return {
    stream: createReadStream(file, { encoding: 'utf8' }),
    filename: `${safeName(projectName)}.events.jsonl`,
  };
}

/** Build a zip of the whole package into a temp file. Caller must delete it. */
export async function exportZip(
  dataDir: string,
  projectId: string,
): Promise<{ file: string; filename: string } | null> {
  const src = projectOutputDir(dataDir, projectId);
  try {
    await stat(path.join(src, 'manifest.json'));
  } catch {
    return null;
  }
  const projectName = await projectNameOf(src, projectId);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'aitimeline-export-'));
  const zipPath = path.join(tmpDir, `${safeName(projectName)}.ai-timeline.zip`);
  // Read-only on the package: zip only reads from src and writes to temp.
  await execFileAsync('zip', ['-q', '-r', zipPath, '.'], { cwd: src, timeout: 120_000 });
  return { file: zipPath, filename: path.basename(zipPath) };
}

/** Sanitize a JSONL line: drop blank lines and any line mentioning a blocked path token. */
export function lineAllowed(line: string): boolean {
  if (!line.trim()) return false;
  return !mentionsBlocked(line);
}

function safeName(name: string): string {
  return name.replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'timeline';
}
