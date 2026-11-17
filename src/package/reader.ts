import path from 'node:path';
import { access } from 'node:fs/promises';
import { IoError } from '../core/errors.js';
import { readJsonObject, readJsonl, type JsonlIssue } from '../core/jsonl.js';
import { assertReadableDirectory } from '../core/fs.js';
import type {
  ActivityEvent,
  AgentIdentity,
  ConflictRecord,
  EventRelation,
  GitCommitRecord,
  GitPushRecord,
  Manifest,
  MergeReport,
  ScanInputs,
  ScanReport,
  SessionRecord,
  SourceEntry,
  TaskRecord,
  TimelineDevice,
  TimelineProject,
} from '../schema/entities.js';
import { emptyTimeline, type TimelineData } from './model.js';

export interface ReadResult {
  data: TimelineData;
  issues: Array<JsonlIssue & { file: string }>;
  missing: string[];
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function readOptionalJson<T>(root: string, relative: string, fallback: T): Promise<{ value: T; missing: boolean }> {
  const target = path.join(root, relative);
  if (!(await fileExists(target))) return { value: fallback, missing: true };
  return { value: await readJsonObject<T>(target), missing: false };
}

async function readOptionalJsonl<T>(
  root: string,
  relative: string,
  issues: ReadResult['issues'],
): Promise<T[]> {
  const target = path.join(root, relative);
  if (!(await fileExists(target))) return [];
  const result = await readJsonl<T>(target);
  for (const issue of result.issues) issues.push({ ...issue, file: relative });
  return result.records;
}

const REQUIRED = ['manifest.json', 'project.json', 'devices.json', 'agents.json', 'events.jsonl'];

/** Read a package into memory. Structural validation is performed by validatePackage(). */
export async function readPackage(root: string): Promise<ReadResult> {
  await assertReadableDirectory(root, 'Timeline Package');
  const issues: ReadResult['issues'] = [];
  const missing: string[] = [];
  const data = emptyTimeline();

  for (const required of REQUIRED) {
    try {
      await access(path.join(root, required));
    } catch {
      missing.push(required);
    }
  }
  if (missing.length > 0) {
    throw new IoError(`Not a valid Timeline Package (missing ${missing.join(', ')}): ${root}`);
  }

  data.manifest = await readJsonObject<Manifest>(path.join(root, 'manifest.json'));
  data.project = await readJsonObject<TimelineProject>(path.join(root, 'project.json'));
  data.devices = await readJsonObject<TimelineDevice[]>(path.join(root, 'devices.json'));
  data.agents = await readJsonObject<AgentIdentity[]>(path.join(root, 'agents.json'));
  data.events = await readOptionalJsonl<ActivityEvent>(root, 'events.jsonl', issues);
  data.sessions = await readOptionalJsonl<SessionRecord>(root, 'sessions.jsonl', issues);
  data.tasks = await readOptionalJsonl<TaskRecord>(root, 'tasks.jsonl', issues);
  data.relations = await readOptionalJsonl<EventRelation>(root, 'relations.jsonl', issues);
  data.commits = await readOptionalJsonl<GitCommitRecord>(root, 'git/commits.jsonl', issues);
  data.pushes = await readOptionalJsonl<GitPushRecord>(root, 'git/pushes.jsonl', issues);
  data.sources = await readOptionalJsonl<SourceEntry>(root, 'sources/source-index.jsonl', issues);
  data.conflicts = await readOptionalJsonl<ConflictRecord>(root, 'reports/conflicts.jsonl', issues);

  const inputs = await readOptionalJson<ScanInputs | undefined>(root, 'sources/scan-inputs.json', undefined);
  if (inputs.value) data.scanInputs = inputs.value;
  const scanReport = await readOptionalJson<ScanReport | undefined>(root, 'reports/scan-report.json', undefined);
  if (scanReport.value) data.scanReport = scanReport.value;
  const mergeReport = await readOptionalJson<MergeReport | undefined>(root, 'reports/merge-report.json', undefined);
  if (mergeReport.value) data.mergeReport = mergeReport.value;

  return { data, issues, missing };
}
