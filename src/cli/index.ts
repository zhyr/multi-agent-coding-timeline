import { Command } from 'commander';
import path from 'node:path';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { FORMAT_VERSION, SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSIONS, EXIT } from '../core/constants.js';
import { UsageError, ValidationError, errorMessage, errorExitCode } from '../core/errors.js';
import { summarizeAdapters } from '../adapters/registry.js';
import { runScan } from '../scan/engine.js';
import { runMerge } from '../merge/engine.js';
import { readPackage, validatePackage } from '../package/index.js';
import { renderTimelineHtml } from '../viewer/build.js';
import {
  parseAgents,
  parseContentMode,
  printError,
  printJson,
  printValidation,
  progressLine,
  truncate,
} from './output.js';

export const CLI_VERSION = '1.0.0';

interface GlobalJson {
  json?: boolean;
  quiet?: boolean;
}

function numberOption(value: string | undefined, fallback: number | undefined): number | undefined {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new UsageError(`expected a positive integer, got "${value}"`);
  return parsed;
}

export function createProgram(): { program: Command; getExitCode: () => number } {
  const program = new Command();
  let exitCode: number = EXIT.OK;
  program
    .name('aitimeline')
    .description(
      'Local-first, read-only toolkit that reconstructs a unified, verifiable development timeline ' +
        'across AI coding agents, projects and devices. Nothing is monitored in the background; ' +
        'all source records and Git repositories are read-only inputs.',
    )
    .version(CLI_VERSION, '-V, --version', 'show version');

  program
    .command('scan')
    .description('Scan agent records and Git history for one project (local or remote source)')
    .requiredOption('--project <path>', 'target project directory (must be readable)')
    .option('--output <path>', 'Timeline Package output directory', './timeline.ai-timeline')
    .option('--source-root <path>', 'explicit agent data root, e.g. a mounted device or backup')
    .option('--source-device <id>', 'device that OWNS the source records (required with --source-root)')
    .option('--scanner-device <id>', 'override the id of the device executing this scan')
    .option('--agents <ids>', 'comma-separated adapter ids (default: all)')
    .option('--content-mode <mode>', 'metadata_only | summary | full (default: summary)')
    .option('--include-candidates', 'include candidate-grade project matches (default: excluded)')
    .option('--force', 'allow replacing a non-empty output directory')
    .option('--force-rescan', 'ignore incremental state and re-parse every source file')
    .option('--dry-run', 'compute everything but write nothing')
    .option('--state-dir <path>', 'directory for incremental scan state')
    .option('--max-commits <n>', 'limit the number of Git commits collected')
    .option('--project-id <id>', 'explicit project id override')
    .option('--remote-url <url>', 'explicit canonical remote URL override')
    .option('--json', 'machine-readable JSON on stdout')
    .option('--quiet', 'suppress progress output')
    .action(async (opts) => {
      const json = !!opts.json;
      const quiet = !!opts.quiet || json;
      const outcome = await runScan({
        project: opts.project,
        output: opts.output,
        sourceRoot: opts.sourceRoot,
        sourceDevice: opts.sourceDevice,
        scannerDevice: opts.scannerDevice,
        agents: parseAgents(opts.agents),
        contentMode: parseContentMode(opts.contentMode),
        includeCandidates: !!opts.includeCandidates,
        force: !!opts.force,
        forceRescan: !!opts.forceRescan,
        dryRun: !!opts.dryRun,
        stateDir: opts.stateDir,
        maxCommits: numberOption(opts.maxCommits, undefined),
        explicitProjectId: opts.projectId,
        explicitRemoteUrl: opts.remoteUrl,
        onProgress: (m) => progressLine(quiet, m),
      });
      const r = outcome.report;
      // The exit code must be identical in text and --json mode; otherwise CI
      // consumers of the machine-readable output cannot detect a failed scan.
      if (r.errors.length) exitCode = EXIT.SCAN_FAILED;
      if (json) {
        printJson({
          ok: r.errors.length === 0,
          operation: 'scan',
          dry_run: outcome.dryRun,
          output: outcome.outputPath,
          source_device_id: outcome.sourceDeviceId,
          scanner_device_id: outcome.scannerDeviceId,
          manifest: outcome.data.manifest,
          report: outcome.report,
        });
      } else {
        process.stdout.write(
          `Scan ${outcome.dryRun ? '(dry run) ' : ''}complete\n` +
            `  output:            ${outcome.outputPath}\n` +
            `  source device:     ${outcome.sourceDeviceId}\n` +
            `  scanner device:    ${outcome.scannerDeviceId}\n` +
            `  project:           ${outcome.data.manifest.project_name} (${outcome.data.manifest.project_id})\n` +
            `  identity:          ${outcome.data.manifest.project_identity_basis}` +
            `${outcome.data.manifest.project_identity_strong ? '' : ' [WEAK]'}\n` +
            `  sources:           ${r.sources_discovered} discovered, ${r.sources_scanned} scanned, ` +
            `${r.sources_skipped_unchanged} unchanged, ${r.sources_failed} failed\n` +
            `  sessions:          ${r.sessions_discovered} discovered, ${r.sessions_matched} matched, ` +
            `${r.sessions_reused_unchanged} reused unchanged, ${r.sessions_candidates_included} candidates explicitly included, ` +
            `${r.sessions_candidate_only} candidate-only excluded\n` +
            `  events:            ${r.events_extracted} extracted, ${r.events_rejected} rejected/excluded, ` +
            `${outcome.data.events.length} final\n` +
            `  git:               ${r.git_commits} commits, ${r.git_pushes} evidenced pushes\n` +
            `  malformed:         ${r.malformed_records} isolated records\n` +
            `  redacted:          ${r.redacted_records} records\n`,
        );
        if (r.warnings.length) process.stdout.write(`  warnings:          ${r.warnings.length} (see reports/scan-report.json)\n`);
        if (r.errors.length) {
          process.stdout.write(`  errors:            ${r.errors.length}\n`);
          exitCode = EXIT.SCAN_FAILED;
        }
      }
    });

  program
    .command('merge')
    .description('Merge two or more device-level Timeline Packages into one unified package')
    .argument('<inputs...>', 'input Timeline Package directories')
    .requiredOption('--output <path>', 'unified Timeline Package output directory')
    .option('--force', 'allow replacing a non-empty output directory')
    .option('--dry-run', 'compute everything but write nothing')
    .option('--allow-weak-identity', 'explicitly confirm merging name-derived (weak) project identities')
    .option('--json', 'machine-readable JSON on stdout')
    .option('--quiet', 'suppress progress output')
    .action(async (inputs: string[], opts) => {
      const json = !!opts.json;
      const quiet = !!opts.quiet || json;
      const outcome = await runMerge({
        inputs,
        output: opts.output,
        force: !!opts.force,
        dryRun: !!opts.dryRun,
        allowWeakIdentity: !!opts.allowWeakIdentity,
        onProgress: (m) => progressLine(quiet, m),
      });
      if (json) {
        printJson({
          ok: true,
          operation: 'merge',
          dry_run: outcome.dryRun,
          output: outcome.outputPath,
          manifest: outcome.data.manifest,
          report: outcome.report,
        });
      } else {
        const r = outcome.report;
        process.stdout.write(
          `Merge ${outcome.dryRun ? '(dry run) ' : ''}complete\n` +
            `  output:            ${outcome.outputPath}\n` +
            `  inputs:            ${r.input_timelines} package(s) from ${r.source_devices} source device(s)\n` +
            `  project identity:  ${r.project_identity_status}\n` +
            `  events:            ${r.input_events} in -> ${r.merged_events} out\n` +
            `  duplicates:        ${r.duplicate_events} removed\n` +
            `  conflicts:         ${r.conflict_events} preserved as variants\n` +
            `  unresolved rel:    ${r.unresolved_relations}\n`,
        );
        if (r.warnings?.length) process.stdout.write(`  warnings:          ${r.warnings.length} (see reports/merge-report.json)\n`);
      }
    });

  program
    .command('inspect')
    .description('Show a human-readable summary of a Timeline Package')
    .argument('<package>', 'Timeline Package directory')
    .option('--events <n>', 'number of leading events to display', '5')
    .option('--json', 'machine-readable JSON on stdout')
    .action(async (pkg: string, opts) => {
      const { data, issues } = await readPackage(pkg);
      const limit = numberOption(opts.events, 5) ?? 5;
      const sample = data.events.slice(0, limit).map((e) => ({
        event_id: e.event_id,
        time: e.time.occurred_at ?? e.time.observed_at,
        sort_basis: e.time.sort_basis,
        event_type: e.event_type,
        agent: e.agent?.agent_id ?? 'git',
        device: e.device_id,
        evidence: e.evidence.level,
        summary: truncate(e.activity?.content_summary ?? e.activity?.content ?? '', 100) || undefined,
        source: e.provenance.source_path,
        source_record_id: e.provenance.source_record_id,
      }));
      const summary = {
        package: pkg,
        format: data.manifest.format,
        format_version: data.manifest.format_version,
        schema_version: data.manifest.schema_version,
        timeline_id: data.manifest.timeline_id,
        operation: data.manifest.operation,
        project: { id: data.manifest.project_id, name: data.manifest.project_name, basis: data.manifest.project_identity_basis, strong: data.manifest.project_identity_strong },
        content_mode: data.manifest.content_mode,
        counts: {
          events: data.events.length,
          sessions: data.sessions.length,
          tasks: data.tasks.length,
          agents: data.agents.length,
          devices: data.devices.length,
          commits: data.commits.length,
          pushes: data.pushes.length,
          relations: data.relations.length,
          sources: data.sources.length,
          conflicts: data.conflicts.length,
        },
        source_devices: data.manifest.source_devices,
        devices: data.devices.map((d) => ({ device_id: d.device_id, role: d.role, scanner_device_id: d.scanner_device_id })),
        agents: data.agents.map((a) => ({ id: a.agent_id, verification: a.verification })),
        reports: { scan: !!data.scanReport, merge: !!data.mergeReport },
        jsonl_issues: issues.length,
        events_sample: sample,
      };
      if (opts.json) {
        printJson(summary);
        return;
      }
      process.stdout.write(
        `Timeline Package: ${pkg}\n` +
          `  format:      ${summary.format} ${summary.format_version} (schema ${summary.schema_version})\n` +
          `  operation:   ${summary.operation}  timeline_id=${summary.timeline_id}\n` +
          `  project:     ${summary.project.name} (${summary.project.id})\n` +
          `  identity:    ${summary.project.basis}${summary.project.strong ? '' : ' [WEAK]'}\n` +
          `  content:     ${summary.content_mode}\n` +
          `  counts:      ${summary.counts.events} events, ${summary.counts.sessions} sessions, ` +
          `${summary.counts.agents} agents, ${summary.counts.devices} devices, ` +
          `${summary.counts.commits} commits, ${summary.counts.pushes} pushes\n` +
          `  devices:     ${summary.devices.map((d) => `${d.device_id}(${d.role ?? 'source'})`).join(', ')}\n` +
          `  reports:     scan=${summary.reports.scan} merge=${summary.reports.merge}\n` +
          `  jsonl issues:${summary.jsonl_issues}\n` +
          `  first ${sample.length} event(s):\n`,
      );
      for (const e of sample) {
        process.stdout.write(
          `    ${e.time} [${e.evidence}] ${e.event_type} <${e.agent}> ${e.summary ?? ''}\n` +
            `      source: ${e.source}#${e.source_record_id}\n`,
        );
      }
    });

  program
    .command('viewer')
    .description('Render a validated Timeline Package as one self-contained, offline HTML file')
    .argument('<package>', 'Timeline Package directory')
    .option('--output <file>', 'HTML output file', './timeline.html')
    .option('--title <title>', 'override the page title')
    .option('--force', 'overwrite an existing output file')
    .option('--json', 'machine-readable JSON on stdout')
    .action(async (pkg: string, opts) => {
      const validation = await validatePackage(pkg);
      if (!validation.ok) {
        throw new ValidationError(
          `Package failed validation (${validation.errors.length} error(s)): ${validation.errors[0] ?? 'unknown error'}`,
          validation.errors,
        );
      }
      const { data } = await readPackage(pkg);
      const html = renderTimelineHtml(data, { title: opts.title });
      const target = path.resolve(opts.output);
      try {
        const existing = await stat(target);
        if (existing.isDirectory()) throw new UsageError(`Output path is a directory: ${target}`);
        if (!opts.force) throw new UsageError(`Output file already exists: ${target}. Use --force to replace it.`);
      } catch (error) {
        if (error instanceof UsageError) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, html, 'utf8');
      if (opts.json) {
        printJson({
          ok: true,
          operation: 'viewer',
          output: target,
          bytes: Buffer.byteLength(html, 'utf8'),
          events: data.events.length,
          sessions: data.sessions.length,
          commits: data.commits.length,
        });
      } else {
        process.stdout.write(
          `Viewer written\n` +
            `  output:   ${target}\n` +
            `  size:     ${Buffer.byteLength(html, 'utf8')} bytes (single file, no network access)\n` +
            `  contents: ${data.events.length} events, ${data.sessions.length} sessions, ${data.commits.length} commits\n`,
        );
      }
    });

  program
    .command('validate')
    .description('Validate schema, references and SHA-256 integrity of a Timeline Package')
    .argument('<package>', 'Timeline Package directory')
    .option('--json', 'machine-readable JSON on stdout')
    .action(async (pkg: string, opts) => {
      const result = await validatePackage(pkg);
      if (opts.json) printJson(result);
      else printValidation(result, pkg);
      if (!result.ok) exitCode = EXIT.VALIDATION_FAILED;
    });

  program
    .command('adapters')
    .description('List agent adapters and their honest capability matrix')
    .option('--agent <id>', 'show full details for one adapter')
    .option('--json', 'machine-readable JSON on stdout')
    .action((opts) => {
      let list = summarizeAdapters();
      if (opts.agent) list = list.filter((a) => a.id === opts.agent.toLowerCase());
      if (!list.length) throw new UsageError(`Unknown adapter "${opts.agent}"`);
      if (opts.json) {
        printJson(list);
        return;
      }
      process.stdout.write('Agent adapter capability matrix (verified | partial | unavailable)\n');
      for (const a of list) {
        process.stdout.write(`\n${a.id} — ${a.name} v${a.version} [${a.verification}]\n`);
        process.stdout.write(`  formats: ${a.formats.join(', ') || '(none verified)'}\n`);
        for (const [k, v] of Object.entries(a.capabilities)) {
          process.stdout.write(`  ${k.padEnd(20)} ${v}\n`);
        }
        if (opts.agent) for (const note of a.notes) process.stdout.write(`  note: ${note}\n`);
      }
      if (!opts.agent) process.stdout.write('\nUse --agent <id> for verification notes and known limitations.\n');
    });

  program
    .command('report')
    .description('Print the scan or merge report stored in a Timeline Package')
    .argument('<package>', 'Timeline Package directory')
    .option('--kind <kind>', 'scan | merge (default: whichever exists)')
    .option('--json', 'machine-readable JSON on stdout')
    .action(async (pkg: string, opts) => {
      const { data } = await readPackage(pkg);
      const report = opts.kind === 'merge' ? data.mergeReport : opts.kind === 'scan' ? data.scanReport : data.scanReport ?? data.mergeReport;
      if (!report) throw new UsageError(`No ${opts.kind ?? 'scan/merge'} report in ${pkg}`);
      if (opts.json) {
        printJson(report);
        return;
      }
      if (report.operation === 'scan') {
        process.stdout.write(
          `Scan report — project ${report.project_id}\n` +
            `  source/scanner:  ${report.source_device_id} / ${report.scanner_device_id}\n` +
            `  window:          ${report.started_at} -> ${report.completed_at}\n` +
            `  sources:         ${report.sources_discovered} discovered, ${report.sources_scanned} scanned, ` +
            `${report.sources_skipped_unchanged} unchanged, ${report.sources_failed} failed\n` +
            `  sessions:        ${report.sessions_discovered} discovered, ${report.sessions_matched} matched, ` +
            `${report.sessions_candidate_only} candidate-only\n` +
            `  events:          ${report.events_extracted} extracted, ${report.events_rejected} rejected/excluded, ` +
            `${report.malformed_records} malformed, ${report.redacted_records} redacted\n` +
            `  git:             ${report.git_commits} commits, ${report.git_pushes} evidenced pushes\n` +
            `  symlinks skipped:${report.symlinks_skipped}\n`,
        );
        for (const c of report.candidates ?? []) {
          process.stdout.write(`  candidate: ${c.agent_id}/${c.native_session_id} — ${c.confidence}: ${c.basis}\n`);
        }
      } else {
        process.stdout.write(
          `Merge report — project ${report.project_id}\n` +
            `  inputs:          ${report.input_timelines} from ${report.source_devices} source device(s)\n` +
            `  identity:        ${report.project_identity_status}\n` +
            `  events:          ${report.input_events} in -> ${report.merged_events} out ` +
            `(${report.duplicate_events} duplicates, ${report.conflict_events} conflicts preserved)\n` +
            `  unresolved rel:  ${report.unresolved_relations}\n`,
        );
      }
      const reportErrors: string[] =
        'errors' in report && Array.isArray(report.errors)
          ? (report.errors as unknown[]).map((e) => String(e))
          : [];
      for (const w of report.warnings ?? []) process.stdout.write(`  warning: ${w}\n`);
      for (const e of reportErrors) process.stdout.write(`  error:   ${e}\n`);
    });

  program
    .command('version')
    .description('Show build, schema and runtime versions')
    .option('--json', 'machine-readable JSON on stdout')
    .action((opts) => {
      const info = {
        name: 'aitimeline',
        version: CLI_VERSION,
        format: 'ai-coding-timeline',
        format_version: FORMAT_VERSION,
        schema_version: SCHEMA_VERSION,
        supported_schema_versions: SUPPORTED_SCHEMA_VERSIONS,
        node: process.version,
        platform: process.platform,
      };
      if (opts.json) printJson(info);
      else process.stdout.write(`aitimeline ${CLI_VERSION} (schema ${SCHEMA_VERSION}, node ${info.node}, ${info.platform})\n`);
    });

  return { program, getExitCode: () => exitCode };
}

/** Run the CLI and return a deterministic exit code. */
export async function run(argv: string[] = process.argv): Promise<number> {
  const { program, getExitCode } = createProgram();
  try {
    await program.parseAsync(argv);
    if (getExitCode() !== EXIT.OK) return getExitCode();
    return process.exitCode && typeof process.exitCode === 'number' ? process.exitCode : EXIT.OK;
  } catch (error) {
    printError(errorMessage(error));
    if (process.env.AITIMELINE_DEBUG && error instanceof Error) printError(error.stack ?? '');
    return errorExitCode(error);
  }
}
