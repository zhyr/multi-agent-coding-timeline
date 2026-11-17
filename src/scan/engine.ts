import path from 'node:path';
import { hostname, platform } from 'node:os';
import { FORMAT, FORMAT_VERSION, SCHEMA_VERSION, type ContentMode } from '../core/constants.js';
import { UsageError, ScanError, errorMessage } from '../core/errors.js';
import { assertReadableDirectory, displayPath, inspectPath } from '../core/fs.js';
import { shortId, hashObject } from '../core/hash.js';
import { computeDeviceId, computeSessionId, computeTimelineId } from '../core/ids.js';
import { FULL_EXPORT_WARNING } from '../core/redaction.js';
import { expandHome, nowIso } from '../adapters/util.js';
import { createAdapters, selectAdapters } from '../adapters/registry.js';
import type { AgentAdapter, DeclaredSourceDevice, SessionReference } from '../adapters/types.js';
import { buildProjectIdentity } from '../project/identity.js';
import { matchSessionToProject } from '../project/resolver.js';
import { scanGit } from '../git/scanner.js';
import {
  buildSourcePathIdentity,
  normalizeGitCommit,
  normalizeRecord,
  syntheticAdapter,
} from './normalizer.js';
import { deduplicateEvents } from '../merge/dedup.js';
import { readPackage, writePackage } from '../package/index.js';
import { validateData } from '../package/validate.js';
import { emptyTimeline, type TimelineData } from '../package/model.js';
import type {
  ActivityEvent,
  AgentIdentity,
  EventRelation,
  GitPushRecord,
  Manifest,
  ScanInputs,
  ScanReport,
  SessionRecord,
  SourceEntry,
  TaskRecord,
  TimelineDevice,
} from '../schema/entities.js';
import { isUnchanged, loadScanState, saveScanState, stateKey, type ScanState } from './state.js';

export interface ScanOptions {
  project: string;
  output: string;
  sourceRoot?: string;
  sourceDevice?: string;
  scannerDevice?: string;
  agents?: string[];
  contentMode?: ContentMode;
  dryRun?: boolean;
  force?: boolean;
  forceRescan?: boolean;
  includeCandidates?: boolean;
  stateDir?: string;
  maxCommits?: number;
  explicitProjectId?: string;
  explicitRemoteUrl?: string;
  adapters?: AgentAdapter[];
  onProgress?: (message: string) => void;
}

export interface ScanOutcome {
  data: TimelineData;
  report: ScanReport;
  outputPath: string;
  dryRun: boolean;
  sourceDeviceId: string;
  scannerDeviceId: string;
}

function emptyReport(projectId: string, sourceDeviceId: string, scannerDeviceId: string, startedAt: string): ScanReport {
  return {
    operation: 'scan',
    project_id: projectId,
    source_device_id: sourceDeviceId,
    scanner_device_id: scannerDeviceId,
    started_at: startedAt,
    completed_at: startedAt,
    sources_discovered: 0,
    sources_scanned: 0,
    sources_failed: 0,
    sources_skipped_unchanged: 0,
    sessions_discovered: 0,
    sessions_matched: 0,
    sessions_candidate_only: 0,
    events_extracted: 0,
    events_rejected: 0,
    git_commits: 0,
    git_pushes: 0,
    agents: [],
    malformed_records: 0,
    redacted_records: 0,
    symlinks_skipped: 0,
    warnings: [],
    errors: [],
    candidates: [],
  };
}

function pushEvent(
  push: GitPushRecord,
  ctx: {
    projectId: string;
    deviceId: string;
    scannerDeviceId: string;
    observedAt: string;
  },
): ActivityEvent {
  const session: SessionReference = {
    native_session_id: 'git-pushes',
    source: {
      source_id: 'git',
      agent_id: 'git',
      root: '',
      display_path: 'git:refs/remotes',
      format: 'git',
      discovered_from: 'default',
      readable: true,
    },
    path: 'git:refs/remotes',
    relative_path: 'refs/pushes',
    size_bytes: 0,
    project_evidence: {},
  };
  return normalizeRecord(
    {
      event_type: 'git.push.completed',
      occurred_at: push.observed_at,
      timestamp_precision: 'unknown',
      content: push.basis,
      commit_sha: push.commit_sha,
      branch: push.ref,
      evidence_level: push.evidence_level === 'verified' ? 'verified' : 'inferred',
      capture_level: push.evidence_level === 'verified' ? 'observed' : 'derived',
      source_record_id: push.push_id,
      sequence: 0,
    },
    {
      projectId: ctx.projectId,
      sourceDeviceId: ctx.deviceId,
      scannerDeviceId: ctx.scannerDeviceId,
      adapter: syntheticAdapter('git', 'Git'),
      session,
      contentMode: 'metadata_only',
      observedAt: ctx.observedAt,
      matchConfidence: 'exact',
      matchBasis: 'git_worktree',
      sourceType: 'git-repository',
      captureMethod: 'git-remote-refs-read-only',
    },
  );
}

/**
 * Mode A (Local Scan) and Mode B (Remote Source Scan) share this engine.
 * The only difference is the source root and the explicit source device id.
 */
export async function runScan(options: ScanOptions): Promise<ScanOutcome> {
  const startedAt = nowIso();
  const progress = options.onProgress ?? (() => undefined);
  const contentMode: ContentMode = options.contentMode ?? 'summary';
  const projectPath = path.resolve(expandHome(options.project));
  const outputPath = path.resolve(expandHome(options.output));
  const remoteMode = !!options.sourceRoot;
  const sourceRoot = options.sourceRoot ? path.resolve(expandHome(options.sourceRoot)) : undefined;

  await assertReadableDirectory(projectPath, 'project directory');
  if (sourceRoot) await assertReadableDirectory(sourceRoot, 'source root');
  if (contentMode === 'full') progress(`WARNING: ${FULL_EXPORT_WARNING}`);

  const scannerDeviceId =
    options.scannerDevice ?? computeDeviceId(undefined, `scanner:${hostname()}:${platform()}`);

  // ---- Source discovery ----
  // Discovery runs before project identity because an imported archive may
  // declare the source device itself (Al-exporter manifest.device).
  const adapters = selectAdapters(options.agents, options.adapters ?? createAdapters());
  const discoverOptions = sourceRoot ? { roots: [sourceRoot] } : {};
  const usable: Array<{ adapter: AgentAdapter; source: Awaited<ReturnType<AgentAdapter['discoverSources']>>[number] }> = [];
  const discoveryErrors: string[] = [];
  let unknownLayouts = 0;
  for (const adapter of adapters) {
    let found;
    try {
      found = await adapter.discoverSources(discoverOptions);
    } catch (error) {
      discoveryErrors.push(`${adapter.id} discovery failed: ${errorMessage(error)}`);
      continue;
    }
    for (const source of found) {
      if (!source.readable) {
        discoveryErrors.push(`${adapter.id}: source not readable: ${source.display_path}`);
        continue;
      }
      if (source.metadata?.matched_layout === false) {
        unknownLayouts += 1;
        continue;
      }
      usable.push({ adapter, source });
    }
  }

  // Archive-declared device identity. The scanner hostname is never used for a
  // remote source; an explicit --source-device always wins and conflicts are
  // reported instead of silently overridden.
  const declaredDevices = new Map<string, DeclaredSourceDevice>();
  const deviceWarnings: string[] = [];
  for (const { adapter, source } of usable) {
    if (!adapter.declaredSourceDevice) continue;
    try {
      const declared = await adapter.declaredSourceDevice(source);
      if (declared) declaredDevices.set(declared.device_id, declared);
    } catch (error) {
      deviceWarnings.push(`${adapter.id}: device declaration unreadable (${errorMessage(error)})`);
    }
  }
  if (!options.sourceDevice && declaredDevices.size > 1) {
    throw new UsageError(
      `Source roots declare conflicting source devices (${[...declaredDevices.keys()].join(', ')}). Supply --source-device to choose one explicitly.`,
    );
  }
  const declaredDevice = declaredDevices.size === 1 ? [...declaredDevices.values()][0] : undefined;

  let sourceDeviceId: string;
  if (options.sourceDevice) {
    sourceDeviceId = options.sourceDevice;
  } else if (declaredDevice) {
    sourceDeviceId = declaredDevice.device_id;
  } else if (remoteMode) {
    throw new UsageError(
      'Remote source scan requires --source-device, or an archive that declares device.source_device_id. The scanner hostname must never be used to infer the source device identity.',
    );
  } else {
    sourceDeviceId = scannerDeviceId;
  }

  progress(`Project: ${displayPath(projectPath)}`);
  progress(`Source device: ${sourceDeviceId} | Scanner device: ${scannerDeviceId}`);

  const identity = await buildProjectIdentity({
    projectPath,
    deviceId: sourceDeviceId,
    explicitProjectId: options.explicitProjectId,
    explicitRemoteUrl: options.explicitRemoteUrl,
  });
  const projectId = identity.project.project_id;
  const repositoryId = identity.project.repositories[0]?.repository_id;
  const report = emptyReport(projectId, sourceDeviceId, scannerDeviceId, startedAt);
  for (const message of discoveryErrors) {
    report.sources_failed += 1;
    report.errors.push(message);
  }
  report.warnings.push(...deviceWarnings);
  const basis = declaredDevice?.basis ? ` (basis: ${declaredDevice.basis})` : '';
  if (declaredDevice && !options.sourceDevice) {
    report.warnings.push(
      `Source device adopted from the archive declaration ${declaredDevice.source}: ${declaredDevice.device_id}${basis}. Pass --source-device to override it explicitly.`,
    );
  } else if (declaredDevice && options.sourceDevice) {
    if (options.sourceDevice === declaredDevice.device_id) {
      report.warnings.push(
        `--source-device matches the archive declaration ${declaredDevice.source}: ${declaredDevice.device_id}${basis}.`,
      );
    } else {
      report.warnings.push(
        `Device conflict: the archive declares ${declaredDevice.device_id}${basis} in ${declaredDevice.source}, but --source-device ${options.sourceDevice} was supplied. The explicit CLI value wins; imported events are attributed to ${options.sourceDevice}.`,
      );
    }
  } else if (declaredDevices.size > 1) {
    report.warnings.push(
      `Source roots declare multiple devices (${[...declaredDevices.keys()].join(', ')}); --source-device ${options.sourceDevice} was applied to all of them.`,
    );
  }
  if (!identity.project.identity_strong) {
    report.warnings.push(
      'Project identity is name-derived (no git remote and no root commit). Cross-device merge will require explicit confirmation.',
    );
  }
  report.warnings.push(...identity.gitInfo.errors);
  if (options.sourceDevice && !sourceRoot) {
    report.warnings.push(
      `--source-device ${options.sourceDevice} was supplied without --source-root: agent data is read from this machine's default locations and attributed to the explicit source device. Use --source-root when reading a mounted or copied device tree.`,
    );
  }

  const data = emptyTimeline();
  data.project = identity.project;

  // ---- Prior package + incremental state (no watchers; repeated manual runs only) ----
  const stateDir = options.stateDir
    ? path.resolve(expandHome(options.stateDir))
    : path.join(path.dirname(outputPath), '.aitimeline-state');
  const state: ScanState = options.forceRescan
    ? { version: 1, updated_at: startedAt, files: {} }
    : await loadScanState(stateDir, projectId);
  let priorEvents: ActivityEvent[] = [];
  let priorSessions: SessionRecord[] = [];
  if (!options.forceRescan) {
    const outputInfo = await inspectPath(outputPath);
    if (outputInfo.exists && outputInfo.isDirectory && outputInfo.readable) {
      try {
        const prior = await readPackage(outputPath);
        if (prior.data.manifest.project_id === projectId) {
          priorEvents = prior.data.events;
          priorSessions = prior.data.sessions;
        }
      } catch {
        report.warnings.push('Existing output is not a readable Timeline Package; incremental reuse disabled');
      }
    }
  }

  report.sources_discovered = usable.length;
  if (unknownLayouts > 0) {
    report.warnings.push(`${unknownLayouts} source root(s) had no recognizable agent layout and were skipped`);
  }
  progress(`Discovered ${usable.length} usable agent data source(s)`);

  const allEvents: ActivityEvent[] = [];
  const sessionRecords: SessionRecord[] = [];
  const taskRecords: TaskRecord[] = [];
  const sourceEntries: SourceEntry[] = [];
  const usedAgentIds = new Set<string>();
  const nextStateFiles: ScanState['files'] = {};
  let symlinksSkipped = 0;

  for (const { adapter, source } of usable) {
    let sessions: SessionReference[];
    try {
      sessions = await adapter.scanSessions(source);
    } catch (error) {
      report.sources_failed += 1;
      report.errors.push(`${adapter.id} session listing failed: ${errorMessage(error)}`);
      continue;
    }
    report.sessions_discovered += sessions.length;
    const sourceSymlinksSkipped = sessions.length > 0 ? Number(sessions[0]!.metadata?.skipped_symlinks ?? 0) : 0;
    symlinksSkipped += sourceSymlinksSkipped;
    for (const session of sessions) {
      const sessionId = computeSessionId(sourceDeviceId, adapter.id, session.native_session_id);
      const identityPath = buildSourcePathIdentity(adapter.id, session.relative_path);
      const key = stateKey(sourceDeviceId, adapter.id, session.relative_path);

      // Incremental reuse: unchanged files contribute their previously normalized events.
      if (!options.forceRescan && isUnchanged(state, key, session.size_bytes, session.modified_at)) {
        const reused = priorEvents.filter((e) => e.provenance.source_path_identity === identityPath);
        if (reused.length > 0) {
          allEvents.push(...reused);
          const priorSession = priorSessions.find((s) => s.session_id === sessionId);
          if (priorSession) sessionRecords.push(priorSession);
          report.sources_skipped_unchanged += 1;
          sourceEntries.push({
            source_id: shortId('src', key),
            agent_id: adapter.id,
            device_id: sourceDeviceId,
            source_path: displayPath(session.path),
            source_path_identity: identityPath,
            source_type: source.format,
            size_bytes: session.size_bytes,
            modified_at: session.modified_at,
            record_count: reused.length,
            status: 'skipped_unchanged',
            reason: 'fingerprint unchanged since last manual scan',
          });
          nextStateFiles[key] = state.files[key]!;
          usedAgentIds.add(adapter.id);
          continue;
        }
      }

      let parsed;
      try {
        parsed = await adapter.parseSession(session);
      } catch (error) {
        report.sources_failed += 1;
        report.errors.push(`${adapter.id}: failed to parse ${session.relative_path}: ${errorMessage(error)}`);
        sourceEntries.push({
          source_id: shortId('src', key),
          agent_id: adapter.id,
          device_id: sourceDeviceId,
          source_path: displayPath(session.path),
          source_path_identity: identityPath,
          source_type: source.format,
          size_bytes: session.size_bytes,
          status: 'failed',
          reason: errorMessage(error),
        });
        continue;
      }

      report.malformed_records += parsed.issues.length;
      if (parsed.issues.length > 0) {
        report.warnings.push(`${adapter.id}/${session.relative_path}: ${parsed.issues.length} malformed or unsupported records isolated`);
      }
      const evidence = {
        ...session.project_evidence,
        ...parsed.project_evidence,
        cwd: parsed.project_evidence?.cwd ?? session.project_evidence.cwd,
        gitRemote: parsed.project_evidence?.gitRemote ?? session.project_evidence.gitRemote,
        nativeProjectId: parsed.native_project_id,
      };
      const match = matchSessionToProject(evidence, identity);
      if (!match.include && !(options.includeCandidates && match.confidence === 'candidate')) {
        report.sessions_candidate_only += 1;
        if (report.candidates && report.candidates.length < 200) {
          report.candidates.push({
            session_id: sessionId,
            native_session_id: session.native_session_id,
            agent_id: adapter.id,
            basis: match.basis,
            confidence: match.confidence,
          });
        }
        sourceEntries.push({
          source_id: shortId('src', key),
          agent_id: adapter.id,
          device_id: sourceDeviceId,
          source_path: displayPath(session.path),
          source_path_identity: identityPath,
          source_type: source.format,
          size_bytes: session.size_bytes,
          modified_at: session.modified_at,
          record_count: parsed.records.length,
          status: 'partial',
          reason: `excluded: ${match.confidence} project match (${match.basis})`,
        });
        report.events_rejected += parsed.records.length;
        continue;
      }

      const observedAt = nowIso();
      const sourceHash = hashObject({ agent: adapter.id, relative: session.relative_path, size: session.size_bytes, mtime: session.modified_at });
      let count = 0;
      for (const record of parsed.records) {
        allEvents.push(
          normalizeRecord(record, {
            projectId,
            repositoryId,
            sourceDeviceId,
            scannerDeviceId,
            adapter,
            session,
            sessionId,
            contentMode,
            observedAt,
            sourceHash,
            matchConfidence: match.confidence,
            matchBasis: match.basis,
          }),
        );
        count += 1;
      }
      sessionRecords.push({
        session_id: sessionId,
        project_id: projectId,
        device_id: sourceDeviceId,
        agent_id: adapter.id,
        native_session_id: session.native_session_id,
        source_path: displayPath(session.path),
        source_path_identity: identityPath,
        first_seen_at: parsed.session_started_at,
        last_seen_at: parsed.session_ended_at,
        event_count: count,
        match_confidence: match.confidence,
        match_basis: match.basis,
        incomplete: parsed.truncated || session.incomplete,
      });
      const completion = [...parsed.records].reverse().find((r) => r.event_type === 'agent.execution.completed');
      taskRecords.push({
        task_id: shortId('task', sessionId),
        project_id: projectId,
        session_id: sessionId,
        device_id: sourceDeviceId,
        agent_id: adapter.id,
        title: parsed.records.find((r) => r.event_type === 'agent.user_request.submitted')?.content?.slice(0, 120),
        status: completion?.execution_status,
        evidence_level: completion?.evidence_level ?? 'unknown',
        source_record_id: completion?.source_record_id,
      });
      sourceEntries.push({
        source_id: shortId('src', key),
        agent_id: adapter.id,
        device_id: sourceDeviceId,
        source_path: displayPath(session.path),
        source_path_identity: identityPath,
        source_type: source.format,
        size_bytes: session.size_bytes,
        modified_at: session.modified_at,
        sha256: sourceHash,
        record_count: count,
        malformed_records: parsed.issues.length,
        status: parsed.truncated ? 'partial' : 'scanned',
        reason: parsed.truncated ? 'source truncated or partially readable' : undefined,
      });
      nextStateFiles[key] = {
        size_bytes: session.size_bytes,
        modified_at: session.modified_at ?? startedAt,
        record_count: count,
        source_path_identity: identityPath,
        agent_id: adapter.id,
        source_device_id: sourceDeviceId,
      };
      usedAgentIds.add(adapter.id);
      report.sources_scanned += 1;
      report.sessions_matched += 1;
    }
  }
  report.symlinks_skipped = symlinksSkipped;
  progress(`Parsed ${report.sources_scanned} source file(s), ${report.sessions_matched} session(s) matched`);

  // ---- Read-only Git scan ----
  const git = await scanGit({ projectPath, projectId, deviceId: sourceDeviceId, maxCommits: options.maxCommits });
  report.warnings.push(...git.warnings);
  // A directory without Git is explicitly supported, so "not a git repository"
  // must not turn a successful scan into a SCAN_FAILED exit (5).
  if (git.info.isGitRepository) report.errors.push(...git.errors);
  else report.warnings.push(...git.errors);
  for (const commit of git.commits) {
    allEvents.push(
      normalizeGitCommit({
        commitSha: commit.commit_sha,
        parentShas: commit.parent_shas,
        branch: commit.branch,
        message: commit.message,
        authoredAt: commit.authored_at,
        committedAt: commit.committed_at,
        changedFiles: commit.changed_files,
        projectId,
        repositoryId,
        deviceId: sourceDeviceId,
        scannerDeviceId,
        observedAt: nowIso(),
        remoteUrl: identity.remoteUrls[0],
      }),
    );
  }
  for (const push of git.pushes) {
    if (push.evidence_level === 'unknown') continue; // never claim a push without evidence
    allEvents.push(pushEvent(push, { projectId, deviceId: sourceDeviceId, scannerDeviceId, observedAt: nowIso() }));
    report.git_pushes += 1;
  }
  report.git_commits = git.commits.length;
  progress(`Git: ${git.commits.length} commit(s), ${report.git_pushes} evidenced push record(s)`);

  // ---- Deterministic dedup, relations and ordering ----
  const dedup = deduplicateEvents(allEvents);
  const events = dedup.events;
  if (dedup.deterministic_pairs > 0) {
    progress(
      `${dedup.deterministic_pairs} imported Al-exporter event(s) folded deterministically by native session id + message id`,
    );
  }
  if (dedup.line_pairs > 0) {
    progress(
      `${dedup.line_pairs} imported Al-exporter event(s) folded deterministically by original source file + line`,
    );
  }
  if (dedup.inferred_pairs > 0) {
    report.warnings.push(
      `${dedup.inferred_pairs} imported Al-exporter event(s) were paired with native records by session id, type, time and content; the pairing is inferred, not a confirmed identical record`,
    );
  }
  const nativeToEvent = new Map<string, string>();
  for (const event of events) {
    const native = event.agent?.native_event_id;
    if (native && !nativeToEvent.has(native)) nativeToEvent.set(native, event.event_id);
  }
  const relations: EventRelation[] = [];
  for (const event of events) {
    if (event.correlation?.kind !== 'explicit_reference') continue;
    for (const ref of event.correlation.related_event_ids ?? []) {
      const target = nativeToEvent.get(ref);
      if (!target || target === event.event_id) continue;
      relations.push({
        relation_id: shortId('rel', event.event_id, target),
        from_event_id: event.event_id,
        to_event_id: target,
        kind: 'explicit_reference',
        note: 'native parent record reference',
        project_id: projectId,
      });
    }
  }

  report.events_extracted = allEvents.length;
  report.redacted_records = events.filter((e) => (e.redaction_kinds?.length ?? 0) > 0).length;
  report.agents = [...usedAgentIds].sort();
  report.completed_at = nowIso();

  const agents: AgentIdentity[] = adapters
    .filter((a) => usedAgentIds.has(a.id))
    .map((a) => {
      const c = a.getCapabilities();
      return {
        agent_id: a.id,
        agent_name: a.name,
        adapter_version: a.version,
        capabilities: c as unknown as Record<string, unknown>,
        source_format: c.formats.join(','),
        verification: c.verification,
      };
    });

  const devices: TimelineDevice[] = [
    {
      device_id: sourceDeviceId,
      device_name: remoteMode ? undefined : hostname(),
      platform: remoteMode ? undefined : platform(),
      hostname: remoteMode ? undefined : hostname(),
      scanner_device_id: scannerDeviceId,
      first_seen_at: startedAt,
      source_timezone: remoteMode ? undefined : Intl.DateTimeFormat().resolvedOptions().timeZone,
      role: remoteMode ? 'source' : 'both',
    },
  ];
  if (sourceDeviceId !== scannerDeviceId) {
    devices.push({
      device_id: scannerDeviceId,
      hostname: hostname(),
      platform: platform(),
      role: 'scanner',
      first_seen_at: startedAt,
    });
  }

  const scanInputs: ScanInputs = {
    operation: 'scan',
    project_path: displayPath(projectPath),
    source_root: sourceRoot ? displayPath(sourceRoot) : undefined,
    source_device_id: sourceDeviceId,
    scanner_device_id: scannerDeviceId,
    explicit_source_device: !!options.sourceDevice,
    content_mode: contentMode,
    selected_agents: adapters.map((a) => a.id),
    started_at: startedAt,
    adapter_versions: Object.fromEntries(adapters.map((a) => [a.id, a.version])),
    read_only: true,
    notes: remoteMode
      ? ['Remote source scan: source_device_id was supplied explicitly and is distinct from scanner_device_id.']
      : options.sourceDevice
        ? ['Explicit source device without --source-root: default local agent locations were scanned and attributed to the supplied device id.']
        : ['Local scan: source and scanner device are the same machine.'],
  };

  const manifest: Manifest = {
    format: FORMAT,
    format_version: FORMAT_VERSION,
    schema_version: SCHEMA_VERSION,
    timeline_id: computeTimelineId('scan', projectId, [sourceDeviceId, scannerDeviceId, displayPath(projectPath)]),
    project_id: projectId,
    project_name: identity.project.project_name,
    created_at: nowIso(),
    operation: 'scan',
    source_devices: [sourceDeviceId],
    event_count: events.length,
    session_count: sessionRecords.length,
    agent_count: agents.length,
    git_commit_count: git.commits.length,
    content_mode: contentMode,
    project_identity_basis: identity.project.identity_basis,
    project_identity_strong: identity.project.identity_strong,
    generator: { name: 'aitimeline', version: '1.0.0' },
  };

  data.manifest = manifest;
  data.devices = devices;
  data.agents = agents;
  data.sessions = sessionRecords;
  data.tasks = taskRecords;
  data.events = events;
  data.relations = relations;
  data.commits = git.commits;
  data.pushes = git.pushes;
  data.sources = sourceEntries;
  data.scanInputs = scanInputs;
  data.scanReport = report;
  data.conflicts = dedup.conflicts;

  const validation = validateData(data);
  if (!validation.ok) {
    throw new ScanError(`Generated package failed internal validation: ${validation.errors.slice(0, 5).join('; ')}`, validation.errors);
  }
  report.warnings.push(...validation.warnings);
  // The same repository condition can be reported by identity resolution and by
  // the Git scanner; keep one copy so reports stay readable.
  report.warnings = [...new Set(report.warnings)];
  report.errors = [...new Set(report.errors)];
  // Report must be re-embedded after warnings were appended.
  data.scanReport = report;

  if (!options.dryRun) {
    await writePackage(outputPath, data, { overwrite: options.force ?? false });
    const nextState: ScanState = { version: 1, updated_at: report.completed_at, files: nextStateFiles };
    await saveScanState(stateDir, projectId, nextState);
    progress(`Wrote Timeline Package: ${displayPath(outputPath)}`);
  } else {
    progress('Dry run: no files written');
  }

  return { data, report, outputPath, dryRun: !!options.dryRun, sourceDeviceId, scannerDeviceId };
}
