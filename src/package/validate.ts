import path from 'node:path';
import { SUPPORTED_SCHEMA_VERSIONS } from '../core/constants.js';
import { computeEventId, computeConflictEventId } from '../core/ids.js';
import { firstIssue } from '../schema/common.js';
import {
  ActivityEventSchema,
  AgentIdentitySchema,
  ConflictRecordSchema,
  EventRelationSchema,
  GitCommitRecordSchema,
  GitPushRecordSchema,
  ManifestSchema,
  MergeReportSchema,
  ScanInputsSchema,
  ScanReportSchema,
  SessionRecordSchema,
  SourceEntrySchema,
  TaskRecordSchema,
  TimelineDeviceSchema,
  TimelineProjectSchema,
} from '../schema/entities.js';
import type { TimelineData } from './model.js';
import { readPackage, type ReadResult } from './reader.js';
import { verifyChecksums, type ChecksumVerification } from './integrity.js';

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  checks: CheckResult[];
  stats: {
    events: number;
    sessions: number;
    agents: number;
    devices: number;
    commits: number;
    pushes: number;
    relations: number;
    sources: number;
    conflicts: number;
  };
  checksums?: ChecksumVerification;
  readIssues: ReadResult['issues'];
}

function collectionCheck<T>(
  name: string,
  values: readonly T[],
  schema: { safeParse: (v: unknown) => { success: boolean } },
  errors: string[],
  checks: CheckResult[],
  limit = 20,
): void {
  const bad: string[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const result = schema.safeParse(values[i]);
    if (!result.success && bad.length < limit) bad.push(`[${i}] ${firstIssue(schema as never, values[i]) ?? 'invalid'}`);
  }
  const ok = bad.length === 0;
  checks.push({ name, ok, detail: ok ? `${values.length} records` : bad.join('; ') });
  if (!ok) errors.push(`${name}: ${bad.join('; ')}`);
}

/** Validate an in-memory TimelineData. Used before writing and after merging. */
export function validateData(data: TimelineData): Pick<ValidationResult, 'ok' | 'errors' | 'warnings' | 'checks' | 'stats'> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const checks: CheckResult[] = [];
  const check = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, detail });
    if (!ok) errors.push(`${name}${detail ? `: ${detail}` : ''}`);
  };

  const manifestIssue = firstIssue(ManifestSchema, data.manifest);
  check('manifest schema', manifestIssue === undefined, manifestIssue);
  check(
    'schema version supported',
    SUPPORTED_SCHEMA_VERSIONS.includes(data.manifest.schema_version) &&
      SUPPORTED_SCHEMA_VERSIONS.includes(data.manifest.format_version),
    `format_version=${data.manifest.format_version}, schema_version=${data.manifest.schema_version}`,
  );
  check('format identifier', data.manifest.format === 'ai-coding-timeline', String(data.manifest.format));

  const projectIssue = firstIssue(TimelineProjectSchema, data.project);
  check('project schema', projectIssue === undefined, projectIssue);
  check(
    'manifest/project id consistency',
    data.manifest.project_id === data.project.project_id,
    `${data.manifest.project_id} vs ${data.project.project_id}`,
  );

  collectionCheck('devices', data.devices, TimelineDeviceSchema, errors, checks);
  collectionCheck('agents', data.agents, AgentIdentitySchema, errors, checks);
  collectionCheck('sessions', data.sessions, SessionRecordSchema, errors, checks);
  collectionCheck('tasks', data.tasks, TaskRecordSchema, errors, checks);
  collectionCheck('events', data.events, ActivityEventSchema, errors, checks);
  collectionCheck('relations', data.relations, EventRelationSchema, errors, checks);
  collectionCheck('git commits', data.commits, GitCommitRecordSchema, errors, checks);
  collectionCheck('git pushes', data.pushes, GitPushRecordSchema, errors, checks);
  collectionCheck('source index', data.sources, SourceEntrySchema, errors, checks);
  collectionCheck('conflicts', data.conflicts, ConflictRecordSchema, errors, checks);

  if (data.scanInputs) check('scan inputs', firstIssue(ScanInputsSchema, data.scanInputs) === undefined);
  if (data.scanReport) check('scan report', firstIssue(ScanReportSchema, data.scanReport) === undefined);
  if (data.mergeReport) check('merge report', firstIssue(MergeReportSchema, data.mergeReport) === undefined);
  if (!data.scanReport && !data.mergeReport) warnings.push('No scan or merge report present in package');

  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  for (const event of data.events) {
    if (seen.has(event.event_id) && duplicateIds.length < 10) duplicateIds.push(event.event_id);
    seen.add(event.event_id);
  }
  check('event id uniqueness', duplicateIds.length === 0, duplicateIds.join(', '));

  const badIds: string[] = [];
  for (const event of data.events) {
    const expected = computeEventId(event.dedup_key);
    const variant = computeConflictEventId(event.dedup_key, event.content_hash ?? '');
    if (event.event_id !== expected && event.event_id !== variant && badIds.length < 10) {
      badIds.push(event.event_id);
    }
  }
  check('event id derivation', badIds.length === 0, badIds.join(', '));

  const wrongProject = data.events.filter((e) => e.project_id !== data.manifest.project_id);
  check('event project consistency', wrongProject.length === 0, `${wrongProject.length} events with foreign project_id`);

  const sessionIds = new Set(data.sessions.map((s) => s.session_id));
  const danglingSessions = data.events.filter((e) => e.session_id && !sessionIds.has(e.session_id));
  const danglingSessionIds = [...new Set(danglingSessions.map((e) => e.session_id))].slice(0, 4);
  check(
    'session reference integrity',
    danglingSessions.length === 0,
    `${danglingSessions.length} dangling session refs${danglingSessionIds.length > 0 ? ` (${danglingSessionIds.join(', ')})` : ''}`,
  );

  const eventIds = new Set(data.events.map((e) => e.event_id));
  const danglingRelations = data.relations.filter(
    (r) => !eventIds.has(r.from_event_id) || !eventIds.has(r.to_event_id),
  );
  check('relation reference integrity', danglingRelations.length === 0, `${danglingRelations.length} dangling relations`);

  const shaPattern = /^[0-9a-f]{40,64}$/i;
  const badSha = data.commits.filter((c) => !shaPattern.test(c.commit_sha));
  check('commit sha format', badSha.length === 0, `${badSha.length} invalid commit SHAs`);

  const duplicateCommits = data.commits.length - new Set(data.commits.map((c) => c.commit_sha)).size;
  check('commit uniqueness', duplicateCommits === 0, `${duplicateCommits} duplicate commits`);

  const deviceIds = new Set(data.devices.map((d) => d.device_id));
  const declaredDevices = data.manifest.source_devices ?? [];
  const missingDevices = declaredDevices.filter((d) => !deviceIds.has(d));
  check('manifest source devices declared', missingDevices.length === 0, missingDevices.join(', '));

  const countMismatches: string[] = [];
  if (data.manifest.event_count !== data.events.length) countMismatches.push('event_count');
  if (data.manifest.session_count !== data.sessions.length) countMismatches.push('session_count');
  if (data.manifest.agent_count !== data.agents.length) countMismatches.push('agent_count');
  if (data.manifest.git_commit_count !== data.commits.length) countMismatches.push('git_commit_count');
  check('manifest counts', countMismatches.length === 0, countMismatches.join(', '));

  for (const event of data.events) {
    if (event.evidence?.level === 'inferred' && event.correlation === undefined) {
      warnings.push(`Inferred event without correlation metadata: ${event.event_id}`);
      break;
    }
  }
  if (!data.project.identity_strong) {
    warnings.push('Project identity is name-derived (weak); cross-device merge requires explicit confirmation');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    checks,
    stats: {
      events: data.events.length,
      sessions: data.sessions.length,
      agents: data.agents.length,
      devices: data.devices.length,
      commits: data.commits.length,
      pushes: data.pushes.length,
      relations: data.relations.length,
      sources: data.sources.length,
      conflicts: data.conflicts.length,
    },
  };
}

/** Full on-disk validation: structure + schema + referential integrity + SHA-256 checksums. */
export async function validatePackage(root: string): Promise<ValidationResult> {
  const read = await readPackage(path.resolve(root));
  const base = validateData(read.data);
  const errors = [...base.errors];
  const checks = [...base.checks];
  const checksums = await verifyChecksums(path.resolve(root));
  const checksumOk = checksums.ok;
  checks.push({
    name: 'sha256 checksums',
    ok: checksumOk,
    detail: `${checksums.checked} files checked, ${checksums.mismatched.length} mismatched, ${checksums.missing.length} missing, ${checksums.unlisted.length} unlisted`,
  });
  if (!checksumOk) {
    errors.push(
      `sha256 checksums: ${checksums.errors.join('; ')} ${checksums.mismatched.map((m) => m.path).join(', ')} ${checksums.missing.map((m) => m.path).join(', ')} ${checksums.unlisted.join(', ')}`,
    );
  }
  for (const issue of read.issues) {
    errors.push(`malformed JSONL ${issue.file}:${issue.line} ${issue.reason}`);
  }
  checks.push({ name: 'jsonl syntax', ok: read.issues.length === 0, detail: `${read.issues.length} malformed lines` });

  return {
    ok: errors.length === 0,
    errors,
    warnings: base.warnings,
    checks,
    stats: base.stats,
    checksums,
    readIssues: read.issues,
  };
}
