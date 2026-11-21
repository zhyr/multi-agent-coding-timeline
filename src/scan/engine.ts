import path from 'node:path';
import { hostname, platform } from 'node:os';
import { FORMAT, FORMAT_VERSION, SCHEMA_VERSION, type ContentMode } from '../core/constants.js';
import { UsageError, ScanError, errorMessage } from '../core/errors.js';
import { assertReadableDirectory, displayPath, fileSignature, inspectPath, sameFileSignature, type FileSignature } from '../core/fs.js';
import { shortId, hashFileBounded } from '../core/hash.js';
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
import { CONTENT_HASH_LIMIT_BYTES, loadScanState, saveScanState, stateKey, verifyCursor, type ScanState } from './state.js';

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
    sessions_candidates_included: 0,
    sessions_reused_unchanged: 0,
    sources_fingerprint_checked: 0,
    sources_changed_during_read: 0,
    events_extracted: 0,
    events_rejected: 0,
    git_commits: 0,
    git_pushes: 0,
    agents: [],
    malformed_records: 0,
    redacted_records: 0,
    symlinks_skipped: 0,
    inaccessible_directories: 0,
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
  const event = normalizeRecord(
    {
      event_type: 'git.push.completed',
      // Reflog time when a real push was evidenced; otherwise absent so the
      // event falls back to observed_at instead of claiming a fake timestamp.
      occurred_at: push.occurred_at,
      timestamp_precision: push.occurred_at ? 'second' : 'unknown',
      content: push.basis,
      commit_sha: push.commit_sha,
      branch: push.ref,
      evidence_level: push.evidence_level,
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
      captureMethod: 'git-reflog-read-only',
    },
  );
  // Evidence basis is provenance about the Git inspection, not an agent record.
  event.evidence.basis = push.basis;
  return event;
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
  let priorTasks: TaskRecord[] = [];
  if (!options.forceRescan) {
    const outputInfo = await inspectPath(outputPath);
    if (outputInfo.exists && outputInfo.isDirectory && outputInfo.readable) {
      try {
        const prior = await readPackage(outputPath);
        if (prior.data.manifest.project_id === projectId) {
          priorEvents = prior.data.events;
          priorSessions = prior.data.sessions;
          priorTasks = prior.data.tasks;
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
  // Start from the previous state so cursors for other devices/agents survive
  // when they are not part of this scan. Scoped-but-unseen keys are pruned
  // below only when their directory walk completed successfully.
  const nextStateFiles: ScanState['files'] = { ...state.files };
  const seenStateKeys = new Set<string>();
  const enumeratedScopes = new Map<string, boolean>();
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
    const sourceMeta = source.metadata ?? {};
    const sourceSkipped = Number(sourceMeta.skipped_symlinks ?? 0);
    const sessionSkipped = sessions.reduce(
      (max, s) => Math.max(max, Number(s.metadata?.skipped_symlinks ?? 0)),
      0,
    );
    // The source-level counter and its per-session copies are the same value;
    // taking the maximum avoids double counting while still covering sources
    // that never annotate individual sessions.
    symlinksSkipped += Math.max(sourceSkipped, sessionSkipped);
    const inaccessible = Number(sourceMeta.inaccessible_directories ?? 0);
    report.inaccessible_directories = (report.inaccessible_directories ?? 0) + inaccessible;
    if (inaccessible > 0) {
      report.warnings.push(
        `${adapter.id}: ${inaccessible} director(y|ies) under ${source.display_path} could not be read; scan coverage is partial`,
      );
    }
    if (sourceMeta.walk_truncated === true) {
      report.warnings.push(
        `${adapter.id}: directory walk reached its depth/file limit under ${source.display_path}; remaining sessions were not enumerated`,
      );
    }
    const scopeKey = `${sourceDeviceId}\u0000${adapter.id}`;
    const scopeComplete = sourceMeta.walk_truncated !== true && inaccessible === 0;
    enumeratedScopes.set(scopeKey, (enumeratedScopes.get(scopeKey) ?? true) && scopeComplete);
    for (const session of sessions) {
      const sessionId = computeSessionId(sourceDeviceId, adapter.id, session.native_session_id);
      const identityPath = buildSourcePathIdentity(adapter.id, session.relative_path);
      const key = stateKey(sourceDeviceId, adapter.id, session.relative_path);

      // Incremental reuse: size+mtime is only a cheap pre-check. A file is
      // reused only when its content fingerprint still matches the cursor.
      // Sessions whose content spans multiple files (OpenCode) opt out.
      if (!options.forceRescan && !session.incremental_unsafe) {
        const cursor = state.files[key];
        if (cursor) {
          const check = await verifyCursor(cursor, session.path, session.size_bytes, session.modified_at);
          report.sources_fingerprint_checked = (report.sources_fingerprint_checked ?? 0) + 1;
          if (check.status !== 'changed') {
            if (check.status === 'unstable') {
              report.sources_changed_during_read = (report.sources_changed_during_read ?? 0) + 1;
              report.warnings.push(`${adapter.id}/${session.relative_path}: ${check.reason}`);
            }
            const reused = priorEvents.filter((e) => e.provenance.source_path_identity === identityPath);
            if (reused.length > 0) {
              allEvents.push(...reused);
              const priorSession = priorSessions.find((s) => s.session_id === sessionId);
              if (priorSession) {
                sessionRecords.push(check.status === 'unstable' ? { ...priorSession, incomplete: true } : priorSession);
              }
              // Reused sessions must keep their task record too; otherwise an
              // incremental scan silently drops tasks that a full re-parse creates.
              for (const task of priorTasks.filter((t) => t.session_id === sessionId)) {
                taskRecords.push(task);
              }
              report.sources_skipped_unchanged += 1;
              report.sessions_reused_unchanged = (report.sessions_reused_unchanged ?? 0) + 1;
              if (reused.some((e) => (e.provenance.confidence ?? 0) >= 0.8)) report.sessions_matched += 1;
              else report.sessions_candidates_included = (report.sessions_candidates_included ?? 0) + 1;
              sourceEntries.push({
                source_id: shortId('src', key),
                agent_id: adapter.id,
                device_id: sourceDeviceId,
                source_path: displayPath(session.path),
                source_path_identity: identityPath,
                source_type: source.format,
                size_bytes: session.size_bytes,
                modified_at: session.modified_at,
                sha256: cursor.sha256,
                record_count: reused.length,
                status: check.status === 'unchanged' ? 'skipped_unchanged' : 'partial',
                reason: check.status === 'unchanged'
                  ? `fingerprint unchanged (${check.reason})`
                  : `${check.reason}; previous complete snapshot retained, next scan will retry`,
              });
              // Keep the old cursor: the file is still changing, so the next
              // run must re-verify rather than trust this read.
              nextStateFiles[key] = cursor;
              seenStateKeys.add(key);
              usedAgentIds.add(adapter.id);
              continue;
            }
            if (check.status === 'unstable') {
              // No complete prior snapshot to fall back on; defer the file.
              sourceEntries.push({
                source_id: shortId('src', key),
                agent_id: adapter.id,
                device_id: sourceDeviceId,
                source_path: displayPath(session.path),
                source_path_identity: identityPath,
                source_type: source.format,
                size_bytes: session.size_bytes,
                modified_at: session.modified_at,
                record_count: 0,
                status: 'partial',
                reason: `${check.reason}; not committed, will retry on the next scan`,
              });
              continue;
            }
            // Unchanged but no prior events (for example an empty session):
            // fall through and re-parse so the report still counts it.
          }
        }
      }

      // From here on the file is re-read. Drop any previous cursor first; a
      // failed, excluded, truncated or unfingerprinted read must not leave a
      // stale "unchanged" marker behind.
      delete nextStateFiles[key];

      let sigBefore: FileSignature | undefined;
      try {
        sigBefore = await fileSignature(session.path);
      } catch {
        sigBefore = undefined;
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

      // A parsed result is only trustworthy if the file was stable for the
      // whole read. Re-stat after parsing and again after hashing; on any
      // change, discard this read instead of persisting a half-updated session.
      let contentFingerprint:
        | { sha256?: string; kind: 'sha256' | 'stat'; ctime_at: string; inode: number; size: number; mtimeIso: string }
        | undefined;
      let unstableReason: string | undefined;
      if (sigBefore) {
        const sigAfter = await fileSignature(session.path).catch(() => undefined);
        if (!sigAfter || !sameFileSignature(sigBefore, sigAfter)) {
          unstableReason = 'file changed while it was being parsed';
        } else {
          const hashed = await hashFileBounded(session.path, CONTENT_HASH_LIMIT_BYTES).catch(() => undefined);
          const sigFinal = await fileSignature(session.path).catch(() => undefined);
          if (!hashed || !sigFinal || !sameFileSignature(sigAfter, sigFinal)) {
            unstableReason = 'file changed while it was being fingerprinted';
          } else {
            contentFingerprint = {
              sha256: hashed.sha256,
              // Huge files fall back to ctime+inode; transcripts get SHA-256.
              kind: hashed.exceeded ? 'stat' : 'sha256',
              ctime_at: sigFinal.ctimeIso,
              inode: sigFinal.ino,
              size: sigFinal.size,
              mtimeIso: sigFinal.mtimeIso,
            };
          }
        }
      } else {
        report.warnings.push(
          `${adapter.id}/${session.relative_path}: file metadata unavailable; parsed records kept but no reuse fingerprint was recorded`,
        );
      }

      if (unstableReason) {
        report.sources_changed_during_read = (report.sources_changed_during_read ?? 0) + 1;
        report.warnings.push(`${adapter.id}/${session.relative_path}: ${unstableReason}; this read was discarded`);
        const reused = priorEvents.filter((e) => e.provenance.source_path_identity === identityPath);
        if (reused.length > 0) {
          allEvents.push(...reused);
          const priorSession = priorSessions.find((s) => s.session_id === sessionId);
          if (priorSession) sessionRecords.push({ ...priorSession, incomplete: true });
          for (const task of priorTasks.filter((t) => t.session_id === sessionId)) {
            taskRecords.push(task);
          }
          report.sources_skipped_unchanged += 1;
          report.sessions_reused_unchanged = (report.sessions_reused_unchanged ?? 0) + 1;
          if (state.files[key]) {
            nextStateFiles[key] = state.files[key]!;
            seenStateKeys.add(key);
          }
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
          record_count: reused.length,
          status: 'partial',
          reason: reused.length > 0
            ? `${unstableReason}; previous complete snapshot retained, next scan will retry`
            : `${unstableReason}; not committed, will retry on the next scan`,
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
      // Candidate sessions are only here because --include-candidates was
      // explicit. They must not be reported as project matches.
      if (match.confidence === 'candidate') {
        report.sessions_candidates_included = (report.sessions_candidates_included ?? 0) + 1;
      } else report.sessions_matched += 1;
      // Provenance source_hash is the real content fingerprint when available;
      // never the old path+size+mtime pseudo-hash.
      const sourceHash = contentFingerprint?.sha256;
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
        size_bytes: contentFingerprint?.size ?? session.size_bytes,
        modified_at: contentFingerprint?.mtimeIso ?? session.modified_at,
        sha256: contentFingerprint?.sha256,
        record_count: count,
        malformed_records: parsed.issues.length,
        status: parsed.truncated ? 'partial' : 'scanned',
        reason: parsed.truncated ? 'source truncated or partially readable; no reuse cursor recorded' : undefined,
      });
      // A truncated read, or one whose listing carried no mtime (so it can
      // never be verified later), is not recorded as a reusable cursor.
      if (contentFingerprint && !parsed.truncated && session.modified_at) {
        nextStateFiles[key] = {
          size_bytes: contentFingerprint.size,
          modified_at: contentFingerprint.mtimeIso,
          sha256: contentFingerprint.sha256,
          fingerprint_kind: contentFingerprint.kind,
          ctime_at: contentFingerprint.ctime_at,
          inode: contentFingerprint.inode,
          record_count: count,
          source_path_identity: identityPath,
          agent_id: adapter.id,
          source_device_id: sourceDeviceId,
        };
        seenStateKeys.add(key);
      }
      usedAgentIds.add(adapter.id);
      report.sources_scanned += 1;
    }
  }
  report.symlinks_skipped = symlinksSkipped;
  progress(
    `Parsed ${report.sources_scanned} source file(s), ${report.sessions_matched} session(s) matched, ` +
      `${report.sessions_reused_unchanged} reused, ${report.sessions_candidates_included} candidate(s) explicitly included`,
  );
  // Adapter-contributed indexes/audits (for example the Cursor composer index).
  const supplemental = adapters.flatMap((adapter) => adapter.supplementalFiles?.() ?? []);

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
  if (supplemental.length > 0) data.supplemental = supplemental;

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
    // Remove cursors for files that were enumerated but no longer exist (or
    // are no longer reusable). Only prune scopes whose directory walk was
    // complete: a truncated or unreadable walk must not erase state that a
    // later scan could still reuse. Cursors belonging to other devices or
    // unselected agents are preserved.
    for (const [stateKeyValue, cursor] of Object.entries(nextStateFiles)) {
      const scope = `${cursor.source_device_id}\u0000${cursor.agent_id}`;
      if (enumeratedScopes.get(scope) === true && !seenStateKeys.has(stateKeyValue)) {
        delete nextStateFiles[stateKeyValue];
      }
    }
    const nextState: ScanState = { version: 1, updated_at: report.completed_at, files: nextStateFiles };
    await saveScanState(stateDir, projectId, nextState);
    progress(`Wrote Timeline Package: ${displayPath(outputPath)}`);
  } else {
    progress('Dry run: no files written');
  }

  return { data, report, outputPath, dryRun: !!options.dryRun, sourceDeviceId, scannerDeviceId };
}
