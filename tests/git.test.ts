import { describe, it, expect, beforeAll } from 'vitest';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { tempDir, createGitRepo } from './helpers/fixtures.js';
import { scanGit, inspectRepository } from '../src/git/scanner.js';
import { classifyPushEvidence } from '../src/git/push-evidence.js';

const exec = promisify(execFile);
let repo: string;
let shas: string[];

function digest(file: string): Promise<string> {
  return readFile(file).then((b) => createHash('sha256').update(b).digest('hex'));
}

beforeAll(async () => {
  const root = await tempDir('aitimeline-git-');
  repo = path.join(root, 'repo');
  shas = await createGitRepo(repo, {
    remote: 'https://github.com/example/fixture-project.git',
    commits: 2,
    withRemoteTrackingRef: true,
  });
});

describe('Read-only Git Scanner', () => {
  it('extracts commits, parents, messages, author/committer and timestamps', async () => {
    const result = await scanGit({ projectPath: repo, projectId: 'proj_fixture', deviceId: 'device-a' });
    expect(result.commits).toHaveLength(2);
    const second = result.commits.find((c) => c.commit_sha === shas[1])!;
    expect(second.parent_shas).toContain(shas[0]);
    expect(second.message).toBe('synthetic commit 1');
    expect(second.author_name).toBe('Fixture Author');
    expect(second.committer_email).toBe('fixture@example.com');
    expect(second.authored_at).toBeTruthy();
    expect(second.committed_at).toBeTruthy();
    expect(second.evidence_level).toBe('verified');
  });

  it('records branch metadata and diff statistics', async () => {
    const result = await scanGit({ projectPath: repo, projectId: 'proj_fixture', deviceId: 'device-a' });
    expect(result.info.branch).toBe('main');
    expect(result.commits.every((c) => c.branch === 'main')).toBe(true);
    expect(result.commits.some((c) => c.changed_files?.some((f) => f.startsWith('file-')))).toBe(true);
    expect(result.commits.every((c) => c.files_changed !== undefined)).toBe(true);
  });

  it('classifies push evidence conservatively', () => {
    expect(classifyPushEvidence({ reflogHasPushEntry: false, remoteTrackingRefCount: 0, hookLogConfirmsPush: false }).level).toBe('unknown');
    expect(classifyPushEvidence({ reflogHasPushEntry: false, remoteTrackingRefCount: 1, hookLogConfirmsPush: false }).level).toBe('inferred');
    expect(classifyPushEvidence({ reflogHasPushEntry: true, remoteTrackingRefCount: 0, hookLogConfirmsPush: false }).level).toBe('verified');
    expect(classifyPushEvidence({ reflogHasPushEntry: false, remoteTrackingRefCount: 0, hookLogConfirmsPush: true }).level).toBe('verified');
    expect(classifyPushEvidence({ reflogHasPushEntry: false, remoteTrackingRefCount: 0, hookLogConfirmsPush: false }).basis).toMatch(/commits alone/);
  });

  it('does not claim a verified push merely because a remote tracking ref exists', async () => {
    const result = await scanGit({ projectPath: repo, projectId: 'proj_fixture', deviceId: 'device-a' });
    expect(result.pushes.length).toBe(1);
    expect(result.pushes[0]!.evidence_level).not.toBe('verified');
    expect(result.pushes[0]!.evidence_level).toBe('inferred');
    expect(result.warnings.some((w) => w.includes('push evidence level'))).toBe(true);
  });

  it('handles a repository without a remote', async () => {
    const root = await tempDir('aitimeline-git-noremote-');
    const dir = path.join(root, 'repo');
    await createGitRepo(dir, { commits: 1 });
    const info = await inspectRepository(dir);
    expect(info.remoteUrl).toBeUndefined();
    expect(info.isGitRepository).toBe(true);
    const result = await scanGit({ projectPath: dir, projectId: 'proj_x', deviceId: 'd' });
    expect(result.commits).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes('no origin remote'))).toBe(true);
  });

  it('handles a repository with no commits', async () => {
    const root = await tempDir('aitimeline-git-empty-');
    const dir = path.join(root, 'repo');
    await mkdir(dir, { recursive: true });
    await exec('git', ['init', '-q', '-b', 'main', dir]);
    const info = await inspectRepository(dir);
    expect(info.isGitRepository).toBe(true);
    expect(info.hasCommits).toBe(false);
    const result = await scanGit({ projectPath: dir, projectId: 'proj_x', deviceId: 'd' });
    expect(result.commits).toEqual([]);
  });

  it('reports git command failure for a non-repository instead of throwing', async () => {
    const root = await tempDir('aitimeline-git-nongit-');
    await writeFile(path.join(root, 'a.txt'), 'plain directory');
    const info = await inspectRepository(root);
    expect(info.isGitRepository).toBe(false);
    expect(info.errors.length).toBeGreaterThan(0);
    const result = await scanGit({ projectPath: root, projectId: 'proj_x', deviceId: 'd' });
    expect(result.commits).toEqual([]);
  });

  it('never modifies repository state (HEAD, index, config unchanged)', async () => {
    const head = path.join(repo, '.git/HEAD');
    const index = path.join(repo, '.git/index');
    const config = path.join(repo, '.git/config');
    const before = await Promise.all([digest(head), digest(index), digest(config)]);
    await scanGit({ projectPath: repo, projectId: 'proj_fixture', deviceId: 'device-a' });
    const after = await Promise.all([digest(head), digest(index), digest(config)]);
    expect(after).toEqual(before);
  });
});
