import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface FileCursor {
  size_bytes: number;
  modified_at: string;
  sha256?: string;
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

/** Size + mtime fingerprint. Any change forces a full re-parse of that file. */
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
