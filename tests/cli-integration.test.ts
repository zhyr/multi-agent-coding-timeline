import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/cli/index.js';
import { readPackage, writePackage } from '../src/package/index.js';
import { createGitRepo, makeTimelineData, tempDir, writeCodexSession } from './helpers/fixtures.js';

describe('CLI integration: scan + merge + exit codes', () => {
  let root: string;
  let project: string;
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    root = await tempDir('aitimeline-cli-int-');
    project = path.join(root, 'project');
    process.exitCode = undefined;
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await createGitRepo(project, {
      commits: 2,
      remote: 'https://github.com/example/integration-project.git',
      withRemoteTrackingRef: true,
    });
  });

  afterEach(() => {
    stdout.mockRestore();
    stderr.mockRestore();
    process.exitCode = undefined;
  });

  async function scan(
    device: string,
    sessionId: string,
    output: string,
    contentMode: 'metadata_only' | 'summary' = 'metadata_only',
  ): Promise<number> {
    const sourceRoot = path.join(root, device);
    await writeCodexSession(path.join(sourceRoot, '.codex', 'sessions', `rollout-${sessionId}.jsonl`), {
      cwd: project,
      sessionId,
    });
    return run([
      'node', 'aitimeline', 'scan',
      '--project', project,
      '--source-root', sourceRoot,
      '--source-device', device,
      '--output', output,
      '--state-dir', path.join(root, `state-${device}`),
      '--agents', 'codex',
      '--content-mode', contentMode,
      '--quiet',
    ]);
  }

  it('keeps scan failure exit codes identical in text and --json mode', async () => {
    const sourceRoot = path.join(root, 'blocked-source');
    const session = path.join(sourceRoot, '.codex', 'sessions', 'rollout-unreadable.jsonl');
    await writeCodexSession(session, { cwd: project, sessionId: 'unreadable' });
    await chmod(session, 0o000);
    const common = [
      'node', 'aitimeline', 'scan',
      '--project', project,
      '--source-root', sourceRoot,
      '--source-device', 'device-blocked',
      '--agents', 'codex',
      '--quiet',
    ];
    try {
      const textCode = await run([...common, '--output', path.join(root, 'out-text')]);
      stdout.mockClear();
      const jsonCode = await run([...common, '--output', path.join(root, 'out-json'), '--json']);
      expect(textCode).toBe(5);
      expect(jsonCode).toBe(5);
      const payload = JSON.parse(stdout.mock.calls.map((c) => String(c[0])).join('')) as { ok: boolean };
      expect(payload.ok).toBe(false);
    } finally {
      await chmod(session, 0o644);
    }
  });

  it('scans two devices, merges them, and re-merges the result idempotently', async () => {
    const a = path.join(root, 'a.ai-timeline');
    const b = path.join(root, 'b.ai-timeline');
    const merged = path.join(root, 'merged.ai-timeline');
    const again = path.join(root, 'again.ai-timeline');

    expect(await scan('device-a', 'session-a', a)).toBe(0);
    expect(await scan('device-b', 'session-b', b)).toBe(0);
    expect(await run(['node', 'aitimeline', 'merge', a, b, '--output', merged, '--quiet'])).toBe(0);

    const mergedData = (await readPackage(merged)).data;
    expect(mergedData.manifest.operation).toBe('merge');
    expect(new Set(mergedData.manifest.source_devices)).toEqual(new Set(['device-a', 'device-b']));
    expect(mergedData.devices.map((d) => d.device_id)).toEqual(
      expect.arrayContaining(['device-a', 'device-b']),
    );
    expect(mergedData.events.length).toBeGreaterThan(0);
    expect(mergedData.scanReport).toBeUndefined();

    const mergeReport = JSON.parse(await readFile(path.join(merged, 'reports', 'merge-report.json'), 'utf8')) as {
      input_timelines: number;
      source_devices: number;
      input_events: number;
      merged_events: number;
    };
    expect(mergeReport.input_timelines).toBe(2);
    expect(mergeReport.source_devices).toBe(2);
    expect(mergeReport.merged_events).toBe(mergedData.events.length);

    expect(await run(['node', 'aitimeline', 'merge', merged, a, '--output', again, '--quiet'])).toBe(0);
    const againData = (await readPackage(again)).data;
    expect(againData.events).toHaveLength(mergedData.events.length);
    const againReport = JSON.parse(await readFile(path.join(again, 'reports', 'merge-report.json'), 'utf8')) as {
      duplicate_events: number;
    };
    expect(againReport.duplicate_events).toBeGreaterThan(0);
    expect(await run(['node', 'aitimeline', 'validate', again])).toBe(0);
  });

  it('returns usage error 2 for an unknown agent and for --source-root without --source-device', async () => {
    expect(await run(['node', 'aitimeline', 'scan', '--project', project, '--agents', 'nope', '--quiet'])).toBe(2);

    const sourceRoot = path.join(root, 'device-x');
    await writeCodexSession(path.join(sourceRoot, '.codex', 'sessions', 'rollout-x.jsonl'), {
      cwd: project,
      sessionId: 'session-x',
    });
    expect(
      await run(['node', 'aitimeline', 'scan', '--project', project, '--source-root', sourceRoot, '--quiet']),
    ).toBe(2);
  });

  it('returns IO error 7 for a missing project directory', async () => {
    const code = await run([
      'node', 'aitimeline', 'scan',
      '--project', path.join(root, 'does-not-exist'),
      '--output', path.join(root, 'missing.ai-timeline'),
      '--quiet',
    ]);
    expect(code).toBe(7);
  });

  it('returns merge error 6 for incompatible project identities', async () => {
    const one = makeTimelineData({
      manifest: { ...makeTimelineData().manifest, project_id: 'proj_one' },
      project: { ...makeTimelineData().project, project_id: 'proj_one' },
    });
    const two = makeTimelineData({
      manifest: { ...makeTimelineData().manifest, project_id: 'proj_two', timeline_id: 'tln_two' },
      project: { ...makeTimelineData().project, project_id: 'proj_two' },
    });
    await writePackage(path.join(root, 'one'), one);
    await writePackage(path.join(root, 'two'), two);
    const code = await run([
      'node', 'aitimeline', 'merge',
      path.join(root, 'one'), path.join(root, 'two'),
      '--output', path.join(root, 'incompatible'),
      '--quiet',
    ]);
    expect(code).toBe(6);
    expect(existsSync(path.join(root, 'incompatible', 'manifest.json'))).toBe(false);
  });

  it('completes a non-git scan with exit 0 and treats the missing repository as a warning', async () => {
    const plain = await mkdtemp(path.join(os.tmpdir(), 'aitimeline-nogit-'));
    await mkdir(path.join(plain, 'src'), { recursive: true });
    const sourceRoot = path.join(root, 'device-plain');
    await writeCodexSession(path.join(sourceRoot, '.codex', 'sessions', 'rollout-plain.jsonl'), {
      cwd: plain,
      sessionId: 'session-plain',
    });
    const output = path.join(root, 'plain.ai-timeline');
    const code = await run([
      'node', 'aitimeline', 'scan',
      '--project', plain,
      '--source-root', sourceRoot,
      '--source-device', 'device-plain',
      '--output', output,
      '--agents', 'codex',
      '--quiet',
    ]);
    expect(code).toBe(0);
    const { data } = await readPackage(output);
    expect(data.scanReport?.errors).toEqual([]);
    expect(data.scanReport?.warnings.some((w) => w.includes('not a git repository'))).toBe(true);
    expect((await readPackage(output)).data.events.length).toBeGreaterThan(0);
  });

  it('rejects a weak name-derived identity at merge time unless explicitly confirmed', async () => {
    const plain = await mkdtemp(path.join(os.tmpdir(), 'aitimeline-weak-'));
    const sourceRoot = path.join(root, 'device-weak');
    await writeCodexSession(path.join(sourceRoot, '.codex', 'sessions', 'rollout-weak.jsonl'), {
      cwd: plain,
      sessionId: 'session-weak',
    });
    const output = path.join(root, 'weak.ai-timeline');
    expect(
      await run([
        'node', 'aitimeline', 'scan',
        '--project', plain,
        '--source-root', sourceRoot,
        '--source-device', 'device-weak',
        '--output', output,
        '--agents', 'codex',
        '--quiet',
      ]),
    ).toBe(0);
    const { data } = await readPackage(output);
    expect(data.manifest.project_identity_strong).toBe(false);

    const merged = path.join(root, 'weak-merged.ai-timeline');
    // Two inputs are required now; the same weak package twice still exercises
    // the identity gate without inventing a second device timeline.
    expect(await run(['node', 'aitimeline', 'merge', output, output, '--output', merged, '--quiet'])).toBe(6);
    expect(
      await run([
        'node', 'aitimeline', 'merge', output, output,
        '--output', merged, '--allow-weak-identity', '--quiet',
      ]),
    ).toBe(0);
    expect((await readPackage(merged)).data.manifest.project_identity_basis).toBe('name');
  });

  it('reuses unchanged source files on a second manual scan', async () => {
    const output = path.join(root, 'incremental.ai-timeline');
    expect(await scan('device-inc', 'session-inc', output)).toBe(0);
    const first = (await readPackage(output)).data;

    const secondCode = await run([
      'node', 'aitimeline', 'scan',
      '--project', project,
      '--source-root', path.join(root, 'device-inc'),
      '--source-device', 'device-inc',
      '--output', output,
      '--state-dir', path.join(root, 'state-device-inc'),
      '--agents', 'codex',
      '--content-mode', 'metadata_only',
      '--force',
      '--quiet',
    ]);
    expect(secondCode).toBe(0);
    const second = (await readPackage(output)).data;
    expect(second.scanReport?.sources_skipped_unchanged).toBe(1);
    expect(second.events.map((e) => e.event_id).sort()).toEqual(first.events.map((e) => e.event_id).sort());
  });

  it('keeps task records when unchanged sources are reused', async () => {
    const output = path.join(root, 'incremental-tasks.ai-timeline');
    expect(await scan('device-task', 'session-task', output)).toBe(0);
    const first = (await readPackage(output)).data;
    expect(first.tasks).toHaveLength(1);

    const secondCode = await run([
      'node', 'aitimeline', 'scan',
      '--project', project,
      '--source-root', path.join(root, 'device-task'),
      '--source-device', 'device-task',
      '--output', output,
      '--state-dir', path.join(root, 'state-device-task'),
      '--agents', 'codex',
      '--content-mode', 'metadata_only',
      '--force',
      '--quiet',
    ]);
    expect(secondCode).toBe(0);
    const second = (await readPackage(output)).data;
    expect(second.scanReport?.sources_skipped_unchanged).toBe(1);
    expect(second.tasks).toHaveLength(1);
    expect(second.tasks[0]!.task_id).toBe(first.tasks[0]!.task_id);
  });

  it('re-parses a source file after it changes', async () => {
    const output = path.join(root, 'changed.ai-timeline');
    expect(await scan('device-change', 'session-change', output, 'summary')).toBe(0);
    const first = (await readPackage(output)).data.events.length;
    const file = path.join(root, 'device-change', '.codex', 'sessions', 'rollout-session-change.jsonl');
    await writeFile(
      file,
      (await readFile(file, 'utf8')).replace('Implemented feature A', 'Implemented feature A with a follow-up'),
    );

    expect(
      await run([
        'node', 'aitimeline', 'scan',
        '--project', project,
        '--source-root', path.join(root, 'device-change'),
        '--source-device', 'device-change',
        '--output', output,
        '--state-dir', path.join(root, 'state-device-change'),
        '--agents', 'codex',
        '--content-mode', 'summary',
        '--force',
        '--quiet',
      ]),
    ).toBe(0);
    const second = (await readPackage(output)).data;
    expect(second.scanReport?.sources_skipped_unchanged).toBe(0);
    expect(second.events.length).toBe(first);
    expect(
      second.events.some((e) =>
        `${e.activity?.content ?? ''} ${e.activity?.content_summary ?? ''}`.includes('follow-up'),
      ),
    ).toBe(true);
  });
});
