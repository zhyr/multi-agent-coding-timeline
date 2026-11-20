import path from 'node:path';
import { FORMAT, FORMAT_VERSION, SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSIONS, type ContentMode } from '../core/constants.js';
import { MergeError, UsageError } from '../core/errors.js';
import { expandHome, nowIso } from '../adapters/util.js';
import { computeTimelineId } from '../core/ids.js';
import { verifyProjectCompatibility } from '../project/resolver.js';
import { deduplicateEvents, mergeById, sortEvents } from './dedup.js';
import { readPackage, validatePackage, writePackage, validateData, emptyTimeline } from '../package/index.js';
import type { TimelineData } from '../package/model.js';
import type { EventRelation, Manifest, MergeReport, TimelineDevice } from '../schema/entities.js';

export interface MergeOptions {
  inputs: string[];
  output: string;
  force?: boolean;
  dryRun?: boolean;
  allowWeakIdentity?: boolean;
  onProgress?: (message: string) => void;
}

export interface MergeOutcome {
  data: TimelineData;
  report: MergeReport;
  outputPath: string;
  dryRun: boolean;
}

function pickContentMode(modes: ContentMode[]): ContentMode {
  if (modes.includes('full')) return 'full';
  if (modes.includes('summary')) return 'summary';
  return 'metadata_only';
}

/**
 * Device identities are reconciled, not deduplicated. The same device id can be
 * the source in one input and the scanner in another; taking the first record
 * would drop its source role and remove it from `manifest.source_devices`.
 */
function mergeDevices(collections: readonly (readonly TimelineDevice[])[]): TimelineDevice[] {
  const grouped = new Map<string, { record: TimelineDevice; roles: Set<string> }>();
  for (const collection of collections) {
    for (const record of collection) {
      const existing = grouped.get(record.device_id);
      if (!existing) {
        grouped.set(record.device_id, {
          record: { ...record },
          roles: new Set(record.role ? [record.role] : []),
        });
        continue;
      }
      if (record.role) existing.roles.add(record.role);
      const target = existing.record as Record<string, unknown>;
      for (const [key, value] of Object.entries(record)) {
        if (key === 'role' || key === 'device_id') continue;
        if (value !== undefined && target[key] === undefined) target[key] = value;
      }
    }
  }
  return [...grouped.values()]
    .map(({ record, roles }) => {
      let role: TimelineDevice['role'];
      if (roles.has('both') || (roles.has('source') && roles.has('scanner'))) role = 'both';
      else if (roles.has('source')) role = 'source';
      else if (roles.has('scanner')) role = 'scanner';
      return { ...record, ...(role ? { role } : {}) };
    })
    .sort((a, b) => a.device_id.localeCompare(b.device_id));
}

/** Mode C: A+B, extensible to A+B+C+N. Deterministic and idempotent. */
export async function runMerge(options: MergeOptions): Promise<MergeOutcome> {
  const progress = options.onProgress ?? (() => undefined);
  if (!options.inputs || options.inputs.length < 2) {
    throw new UsageError('merge requires at least two input Timeline Packages');
  }
  const inputPaths = options.inputs.map((p) => path.resolve(expandHome(p)));
  const outputPath = path.resolve(expandHome(options.output));

  const packages: TimelineData[] = [];
  const schemaWarnings: string[] = [];
  const warnings: string[] = [];

  for (const input of inputPaths) {
    progress(`Validating input: ${input}`);
    const check = await validatePackage(input);
    if (!check.ok) {
      throw new MergeError(`Input package failed validation: ${input}: ${check.errors.slice(0, 4).join('; ')}`, check.errors);
    }
    const { data } = await readPackage(input);
    if (!SUPPORTED_SCHEMA_VERSIONS.includes(data.manifest.schema_version)) {
      throw new MergeError(`Unsupported schema version ${data.manifest.schema_version} in ${input}`);
    }
    if (data.manifest.format !== FORMAT) {
      throw new MergeError(`Unexpected package format ${data.manifest.format} in ${input}`);
    }
    if (data.manifest.schema_version !== SCHEMA_VERSION || data.manifest.format_version !== FORMAT_VERSION) {
      schemaWarnings.push(`${input}: version ${data.manifest.format_version}/${data.manifest.schema_version} normalized to ${FORMAT_VERSION}/${SCHEMA_VERSION}`);
    }
    packages.push(data);
  }

  const compatibility = verifyProjectCompatibility(
    packages.map((p) => ({
      projectId: p.manifest.project_id,
      basis: p.manifest.project_identity_basis,
      strong: p.manifest.project_identity_strong,
      remoteUrl: p.project.canonical_remote_url,
      name: p.project.project_name,
    })),
    { allowWeakIdentity: options.allowWeakIdentity },
  );
  if (!compatibility.ok) {
    throw new MergeError(`Project identity check failed: ${compatibility.reason}`);
  }

  const projectId = packages[0]!.manifest.project_id;
  const project = packages.reduce<TimelineData['project']>((acc, p) => {
    for (const repo of p.project.repositories) {
      if (!acc.repositories.some((r) => r.repository_id === repo.repository_id)) acc.repositories.push(repo);
    }
    for (const worktree of p.project.worktrees) {
      if (!acc.worktrees.some((w) => w.worktree_id === worktree.worktree_id)) acc.worktrees.push(worktree);
    }
    if (!acc.canonical_remote_url && p.project.canonical_remote_url) acc.canonical_remote_url = p.project.canonical_remote_url;
    return acc;
  }, {
    ...packages[0]!.project,
    repositories: [...packages[0]!.project.repositories],
    worktrees: [...packages[0]!.project.worktrees],
  });

  const inputEvents = packages.reduce((n, p) => n + p.events.length, 0);
  const inputTimelineIds = packages.map((p) => p.manifest.timeline_id).sort();
  const dedup = deduplicateEvents(
    packages.flatMap((p) => p.events),
    inputTimelineIds,
  );
  const events = sortEvents(dedup.events);
  if (dedup.deterministic_pairs > 0) {
    warnings.push(
      `${dedup.deterministic_pairs} imported Al-exporter event(s) were folded deterministically by the same agent, native session id and native message id`,
    );
  }
  if (dedup.line_pairs > 0) {
    warnings.push(
      `${dedup.line_pairs} imported Al-exporter event(s) were folded deterministically by the same agent, original source file and source line`,
    );
  }
  if (dedup.inferred_pairs > 0) {
    warnings.push(
      `${dedup.inferred_pairs} imported Al-exporter event(s) were paired with native records by session id, type, time and content; the pairing is inferred, not a confirmed identical record`,
    );
  }
  if (dedup.cross_device_deterministic > 0) {
    warnings.push(
      `${dedup.cross_device_deterministic} cross-device identity group(s) were correlated deterministically (native id / git object / copied session); per-device observations are kept in provenance.observers`,
    );
  }
  if (dedup.cross_device_candidates > 0) {
    warnings.push(
      `${dedup.cross_device_candidates} cross-device content candidate group(s) were associated by inference only; events were preserved and not merged`,
    );
  }
  if (dedup.cross_device_conflicts > 0) {
    warnings.push(
      `${dedup.cross_device_conflicts} cross-device conflict variant(s) were preserved instead of being overwritten`,
    );
  }
  const eventIds = new Set(events.map((e) => e.event_id));

  const relations: EventRelation[] = mergeById(
    packages.map((p) => p.relations),
    (r) => r.relation_id,
  ).filter((r) => eventIds.has(r.from_event_id) && eventIds.has(r.to_event_id));
  const unresolvedRelations =
    packages.reduce((n, p) => n + p.relations.length, 0) - relations.length;

  const data = emptyTimeline();
  data.project = project;
  data.devices = mergeDevices(packages.map((p) => p.devices));
  data.agents = mergeById(packages.map((p) => p.agents), (a) => a.agent_id);
  data.sessions = mergeById(packages.map((p) => p.sessions), (s) => s.session_id);
  data.tasks = mergeById(packages.map((p) => p.tasks), (t) => t.task_id);
  data.events = events;
  data.relations = relations;
  data.commits = mergeById(packages.map((p) => p.commits), (c) => c.commit_sha);
  data.pushes = mergeById(packages.map((p) => p.pushes), (p) => p.push_id);
  data.sources = mergeById(packages.map((p) => p.sources), (s) => s.source_id);
  data.conflicts = mergeById(
    [...packages.map((p) => p.conflicts), dedup.conflicts],
    (c) => `${c.dedup_key}:${c.variant_event_id}`,
  );

  const sourceDevices = [...new Set(data.devices.filter((d) => d.role !== 'scanner').map((d) => d.device_id))].sort();
  if (sourceDevices.length === 0) {
    warnings.push('No source device metadata found in inputs; using manifest source_devices');
    sourceDevices.push(...new Set(packages.flatMap((p) => p.manifest.source_devices)));
  }

  const manifest: Manifest = {
    format: FORMAT,
    format_version: FORMAT_VERSION,
    schema_version: SCHEMA_VERSION,
    timeline_id: computeTimelineId('merge', projectId, inputTimelineIds),
    project_id: projectId,
    project_name: project.project_name,
    created_at: nowIso(),
    operation: 'merge',
    source_devices: sourceDevices,
    input_timelines: inputTimelineIds,
    event_count: events.length,
    session_count: data.sessions.length,
    agent_count: data.agents.length,
    git_commit_count: data.commits.length,
    content_mode: pickContentMode(packages.map((p) => p.manifest.content_mode)),
    project_identity_basis: project.identity_basis,
    project_identity_strong: project.identity_strong,
    generator: { name: 'aitimeline', version: '1.0.0' },
  };
  data.manifest = manifest;

  const report: MergeReport = {
    operation: 'merge',
    project_id: projectId,
    input_timelines: packages.length,
    source_devices: sourceDevices.length,
    input_events: inputEvents,
    merged_events: events.length,
    duplicate_events: dedup.duplicates,
    conflict_events: dedup.conflicts.length,
    cross_device_deterministic: dedup.cross_device_deterministic,
    cross_device_candidates: dedup.cross_device_candidates,
    cross_device_conflicts: dedup.cross_device_conflicts,
    cross_device_merged: dedup.cross_device_merged,
    unresolved_relations: Math.max(0, unresolvedRelations),
    schema_warnings: schemaWarnings,
    project_identity_status: compatibility.status,
    input_timeline_ids: inputTimelineIds,
    input_paths: inputPaths,
    completed_at: nowIso(),
    warnings,
  };
  data.mergeReport = report;

  const validation = validateData(data);
  if (!validation.ok) {
    throw new MergeError(`Merged package failed internal validation: ${validation.errors.slice(0, 5).join('; ')}`, validation.errors);
  }
  warnings.push(...validation.warnings);
  data.mergeReport = report;

  if (!options.dryRun) {
    await writePackage(outputPath, data, { overwrite: options.force ?? false });
    progress(`Wrote unified Timeline Package: ${outputPath}`);
  } else {
    progress('Dry run: no files written');
  }
  progress(`Events: ${inputEvents} in -> ${events.length} out (${dedup.duplicates} duplicates, ${dedup.conflicts.length} conflicts preserved)`);

  return { data, report, outputPath, dryRun: !!options.dryRun };
}
