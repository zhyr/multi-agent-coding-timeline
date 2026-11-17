import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { run } from '../src/cli/index.js';
import { validatePackage, writePackage } from '../src/package/index.js';
import { makeEvent, makeTimelineData, tempDir, writeCodexSession } from './helpers/fixtures.js';

describe('CLI end to end', () => {
  let root: string;
  let project: string;
  let sourceRoot: string;
  let pkg: string;
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    root = await tempDir('aitimeline-cli-');
    project = path.join(root, 'project');
    sourceRoot = path.join(root, 'device-a');
    pkg = path.join(root, 'out.ai-timeline');
    process.exitCode = undefined;
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { createGitRepo } = await import('./helpers/fixtures.js');
    await createGitRepo(project, { commits: 1 });
    await writeCodexSession(path.join(sourceRoot, '.codex', 'sessions', '2026', '11', '17', 'rollout-e2e.jsonl'), {
      cwd: project,
      sessionId: 'e2e-session',
    });
  });

  afterEach(() => {
    stdout.mockRestore();
    stderr.mockRestore();
    process.exitCode = undefined;
  });

  it('scans a device root, then validates, inspects and renders a viewer', async () => {
    const scanCode = await run([
      'node', 'aitimeline', 'scan',
      '--project', project,
      '--source-root', sourceRoot,
      '--source-device', 'device-a',
      '--output', pkg,
      '--state-dir', path.join(root, 'state'),
      '--agents', 'codex',
      '--json',
    ]);
    expect(scanCode).toBe(0);
    expect(existsSync(path.join(pkg, 'manifest.json'))).toBe(true);

    const validation = await validatePackage(pkg);
    expect(validation.ok).toBe(true);

    const inspectCode = await run(['node', 'aitimeline', 'inspect', pkg, '--json']);
    expect(inspectCode).toBe(0);

    const viewerPath = path.join(root, 'viewer.html');
    const viewerCode = await run(['node', 'aitimeline', 'viewer', pkg, '--output', viewerPath, '--json']);
    expect(viewerCode).toBe(0);
    const html = await readFile(viewerPath, 'utf8');
    expect(html).toContain('agent.user_request.submitted');
    expect(html).toContain('Content-Security-Policy');
  });

  it('refuses to overwrite a viewer without --force', async () => {
    const data = makeTimelineData({
      events: [makeEvent()],
      sessions: [],
    });
    await writePackage(path.join(root, 'pkg'), data);
    const viewerPath = path.join(root, 'viewer.html');
    await writeFile(viewerPath, 'existing');
    const code = await run(['node', 'aitimeline', 'viewer', path.join(root, 'pkg'), '--output', viewerPath]);
    expect(code).toBe(2);
    expect(await readFile(viewerPath, 'utf8')).toBe('existing');
  });

  it('reports an IO exit code for a missing package', async () => {
    const code = await run(['node', 'aitimeline', 'viewer', path.join(root, 'missing'), '--output', path.join(root, 'x.html')]);
    expect(code).toBe(7);
  });

  it('exits non-zero when the package is tampered with', async () => {
    const data = makeTimelineData({ events: [makeEvent()] });
    const target = path.join(root, 'tampered');
    await writePackage(target, data);
    const file = path.join(target, 'events.jsonl');
    await writeFile(file, (await readFile(file, 'utf8')).replace('synthetic request', 'tampered request'));
    const code = await run(['node', 'aitimeline', 'viewer', target, '--output', path.join(root, 'y.html')]);
    expect(code).toBe(4);
  });

  it('lists adapters as machine-readable JSON', async () => {
    const code = await run(['node', 'aitimeline', 'adapters', '--json']);
    expect(code).toBe(0);
    const printed = stdout.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(printed) as Array<{ id: string; verification: string }>;
    expect(parsed.some((a) => a.id === 'codex')).toBe(true);
  });
});
