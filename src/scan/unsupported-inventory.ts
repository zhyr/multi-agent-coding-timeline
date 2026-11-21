import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { walkFiles } from '../core/fs.js';
import { expandHome } from '../adapters/util.js';
import type { SupplementalFile } from '../adapters/types.js';

/**
 * Inventory of agent data that this scanner intentionally does not parse.
 * It lists locations and sizes only; no unsupported file content is read
 * beyond a 16-byte header used to distinguish SQLite from encrypted payloads.
 */

export type UnsupportedKind =
  | 'encrypted_conversation'
  | 'encrypted_settings'
  | 'encrypted_database'
  | 'memory_only';

export interface UnsupportedEntry {
  agent_id: string;
  kind: UnsupportedKind;
  /** Home-masked directory or file path. */
  path: string;
  format: string;
  file_count?: number;
  size_bytes?: number;
  reason: string;
  recommendation: string;
  sample_files?: string[];
}

export interface UnsupportedInventory {
  format: 'aitimeline-unsupported-inventory';
  format_version: 1;
  summary: {
    entry_count: number;
    total_size_bytes: number;
    agent_ids: string[];
  };
  entries: UnsupportedEntry[];
  notes: string[];
}

export interface UnsupportedInventoryOptions {
  /** Selected adapter ids; only their sources are inventoried. */
  agentIds: string[];
  /** Discovered source roots per agent id (explicit --source-root or defaults). */
  rootsByAgent?: Record<string, string[]>;
  home?: string;
  platform?: NodeJS.Platform;
  appData?: string;
}

const TRAE_DB_APPS = ['Trae', 'Trae CN', 'Trae Work', 'Trae Work CN', 'TRAE SOLO', 'TRAE SOLO CN'];
const ANTIGRAVITY_DEFAULT_ROOTS = ['~/.gemini/antigravity-ide', '~/.gemini/antigravity'];

function maskHome(target: string, home: string): string {
  if (home && target.startsWith(home)) return `~${target.slice(home.length)}`;
  return target;
}

async function readHeader(target: string, bytes = 16): Promise<string | null> {
  try {
    const handle = await open(target, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead).toString('hex');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

function isSqliteHeader(hex: string | null): boolean {
  return !!hex && hex.startsWith(Buffer.from('SQLite format 3\u0000', 'utf8').toString('hex'));
}

async function summarizePb(root: string, applyHome: (target: string) => string): Promise<{
  fileCount: number;
  sizeBytes: number;
  samples: string[];
} | null> {
  try {
    const info = await stat(root);
    if (!info.isDirectory()) return null;
  } catch {
    return null;
  }
  const walked = await walkFiles(root, {
    maxDepth: 5,
    maxFiles: 5000,
    predicate: (relative, isDirectory) => (isDirectory ? true : relative.endsWith('.pb')),
  });
  if (walked.files.length === 0) return null;
  let sizeBytes = 0;
  for (const relative of walked.files) {
    const info = await stat(path.join(root, relative)).catch(() => null);
    if (info) sizeBytes += info.size;
  }
  return {
    fileCount: walked.files.length,
    sizeBytes,
    samples: walked.files.slice(0, 3).map((relative) => applyHome(path.join(root, relative))),
  };
}

function traeDbCandidates(home: string, platform: NodeJS.Platform, appData?: string): string[] {
  const candidates: string[] = [];
  for (const app of TRAE_DB_APPS) {
    if (platform === 'win32') {
      const base = appData || path.join(home, 'AppData', 'Roaming');
      candidates.push(path.join(base, app, 'ModularData', 'ai-agent', 'database.db'));
    } else if (platform === 'linux') {
      candidates.push(path.join(home, '.config', app, 'ModularData', 'ai-agent', 'database.db'));
    } else {
      candidates.push(
        path.join(home, 'Library', 'Application Support', app, 'ModularData', 'ai-agent', 'database.db'),
      );
    }
  }
  return [...new Set(candidates)];
}

async function antigravityEntries(
  roots: string[],
  home: string,
): Promise<UnsupportedEntry[]> {
  const entries: UnsupportedEntry[] = [];
  for (const root of [...new Set(roots)]) {
    const applyHome = (target: string) => maskHome(target, home);
    for (const [relative, kind] of [
      ['conversations', 'encrypted_conversation'],
      ['implicit', 'encrypted_conversation'],
    ] as const) {
      const summary = await summarizePb(path.join(root, relative), applyHome);
      if (!summary) continue;
      entries.push({
        agent_id: 'antigravity',
        kind,
        path: applyHome(path.join(root, relative)),
        format: 'protobuf',
        file_count: summary.fileCount,
        size_bytes: summary.sizeBytes,
        reason: 'Encrypted protocol-buffer payloads; no plaintext conversation parser is available.',
        recommendation: 'Use the plaintext brain artifacts (task/implementation_plan/walkthrough) instead of these blobs.',
        sample_files: summary.samples,
      });
    }
    const settings = path.join(root, 'user_settings.pb');
    const header = await readHeader(settings);
    if (header) {
      const info = await stat(settings).catch(() => null);
      entries.push({
        agent_id: 'antigravity',
        kind: 'encrypted_settings',
        path: applyHome(settings),
        format: 'protobuf',
        file_count: 1,
        size_bytes: info?.size,
        reason: 'Encrypted user-settings payload; not a conversation source.',
        recommendation: 'Excluded from parsing; it does not contain timeline events.',
      });
    }
  }
  return entries;
}

async function traeEntries(
  home: string,
  platform: NodeJS.Platform,
  appData?: string,
): Promise<UnsupportedEntry[]> {
  const entries: UnsupportedEntry[] = [];
  for (const candidate of traeDbCandidates(home, platform, appData)) {
    const header = await readHeader(candidate);
    if (!header) continue;
    const info = await stat(candidate).catch(() => null);
    const plaintext = isSqliteHeader(header);
    entries.push({
      agent_id: 'trae',
      kind: 'encrypted_database',
      path: maskHome(candidate, home),
      format: 'sqlite',
      file_count: 1,
      size_bytes: info?.size,
      reason: plaintext
        ? 'SQLite database with an unverified Trae SOLO schema; it is not parsed.'
        : `Database header ${header.slice(0, 8)} is not a plaintext SQLite header; the file is encrypted.`,
      recommendation: 'No read-only parser is implemented; scan the plaintext ~/.trae / ~/.trae-cn memory summaries instead.',
    });
  }
  return entries;
}

async function codeBuddyEntries(home: string): Promise<UnsupportedEntry[]> {
  const entries: UnsupportedEntry[] = [];
  for (const relative of ['.codebuddy/memery', '.codebuddy/memory']) {
    const root = path.join(home, relative);
    try {
      const info = await stat(root);
      if (!info.isDirectory()) continue;
    } catch {
      continue;
    }
    const walked = await walkFiles(root, {
      maxDepth: 5,
      maxFiles: 2000,
      predicate: (relativePath, isDirectory) => (isDirectory ? true : relativePath.endsWith('.md')),
    });
    if (walked.files.length === 0) continue;
    let sizeBytes = 0;
    for (const file of walked.files) {
      const info = await stat(path.join(root, file)).catch(() => null);
      if (info) sizeBytes += info.size;
    }
    entries.push({
      agent_id: 'codebuddy',
      kind: 'memory_only',
      path: maskHome(root, home),
      format: 'markdown',
      file_count: walked.files.length,
      size_bytes: sizeBytes,
      reason: 'Only long-term memory notes are present; no verified session transcript format was observed.',
      recommendation: 'Treat as memory context, not a conversation timeline; re-verify if CodeBuddy adds session logs.',
    });
  }
  return entries;
}

export async function collectUnsupportedInventory(
  options: UnsupportedInventoryOptions,
): Promise<SupplementalFile | undefined> {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const selected = new Set(options.agentIds);
  const entries: UnsupportedEntry[] = [];

  if (selected.has('antigravity')) {
    const roots = (options.rootsByAgent?.antigravity ?? ANTIGRAVITY_DEFAULT_ROOTS).map((root) =>
      path.resolve(expandHome(root)),
    );
    entries.push(...(await antigravityEntries(roots, home)));
  }
  if (selected.has('trae')) {
    entries.push(...(await traeEntries(home, platform, options.appData)));
  }
  if (selected.has('codebuddy')) {
    entries.push(...(await codeBuddyEntries(home)));
  }
  if (entries.length === 0) return undefined;

  const byAgent = [...new Set(entries.map((entry) => entry.agent_id))].sort();
  const inventory: UnsupportedInventory = {
    format: 'aitimeline-unsupported-inventory',
    format_version: 1,
    summary: {
      entry_count: entries.length,
      total_size_bytes: entries.reduce((sum, entry) => sum + (entry.size_bytes ?? 0), 0),
      agent_ids: byAgent,
    },
    entries: entries.sort((a, b) => a.agent_id.localeCompare(b.agent_id) || a.path.localeCompare(b.path)),
    notes: [
      'This report lists data that was found but deliberately not parsed.',
      'Only paths, sizes and a 16-byte header sniff are read; encrypted payloads are never decrypted.',
      'See agents.json / the adapters command for what each adapter does support.',
    ],
  };
  return { path: 'reports/unsupported-inventory.json', format: 'json', content: inventory };
}
