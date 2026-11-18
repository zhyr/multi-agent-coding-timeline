import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { tempDir, createGitRepo } from './helpers/fixtures.js';
import { buildProjectIdentity } from '../src/project/identity.js';
import { matchSessionToProject, verifyProjectCompatibility } from '../src/project/resolver.js';
import type { ProjectIdentity } from '../src/project/identity.js';

const REMOTE = 'https://github.com/example/fixture-project.git';
let projectPath: string;
let identity: ProjectIdentity;

beforeAll(async () => {
  const root = await tempDir('aitimeline-project-');
  projectPath = path.join(root, 'fixture-project');
  await createGitRepo(projectPath, { remote: REMOTE, commits: 2 });
  identity = await buildProjectIdentity({ projectPath, deviceId: 'device-fixture' });
});

describe('Project Resolver', () => {
  it('builds a strong remote-derived identity', () => {
    expect(identity.project.identity_basis).toBe('remote');
    expect(identity.project.identity_strong).toBe(true);
    expect(identity.project.canonical_remote_url).toBe('https://github.com/example/fixture-project');
    expect(identity.worktreePaths).toContain(projectPath);
  });

  it('Exact Match: canonical Git remote URL (including SSH form)', () => {
    const result = matchSessionToProject({ gitRemote: 'git@github.com:example/fixture-project.git' }, identity);
    expect(result.confidence).toBe('exact');
    expect(result.basis).toBe('git_remote_url_match');
    expect(result.include).toBe(true);
  });

  it('Exact Match: Git worktree path', () => {
    const result = matchSessionToProject({ cwd: projectPath }, identity);
    expect(result.confidence).toBe('exact');
    expect(result.basis).toBe('worktree_path_match');
    expect(result.include).toBe(true);
  });

  it('Exact Match: agent-native project ID', () => {
    const result = matchSessionToProject({ nativeProjectId: identity.project.project_id }, identity);
    expect(result.confidence).toBe('exact');
    expect(result.basis).toBe('native_project_id_match');
  });

  it('Strong Match: multiple corroborating path signals', () => {
    const result = matchSessionToProject(
      {
        cwd: path.join(projectPath, 'src'),
        projectPathHints: [projectPath],
        nativeProjectId: 'agent-native-1',
      },
      identity,
    );
    expect(result.confidence).toBe('strong');
    expect(result.include).toBe(true);
  });

  it('Strong Match: a cwd inside the worktree is enough', () => {
    const result = matchSessionToProject({ cwd: path.join(projectPath, 'src', 'deep') }, identity);
    expect(result.confidence).toBe('strong');
    expect(result.include).toBe(true);
  });

  it('does not strongly match an ancestor cwd to a nested project', () => {
    const ancestor = path.dirname(projectPath);
    const result = matchSessionToProject(
      { cwd: ancestor, nativeProjectId: ancestor },
      identity,
    );
    expect(result.confidence).toBe('candidate');
    expect(result.include).toBe(false);
    expect(result.reasons.some((reason) => reason.includes('ancestor'))).toBe(true);
  });

  it('Candidate Match: path/name-only evidence is never auto-included', () => {
    const result = matchSessionToProject({ cwd: '/somewhere/else/fixture-project' }, identity);
    expect(result.confidence).toBe('candidate');
    expect(result.include).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('Conflicting identity evidence is downgraded to candidate', () => {
    const result = matchSessionToProject(
      { gitRemote: 'https://github.com/other/unrelated.git', cwd: projectPath },
      identity,
    );
    expect(result.confidence).toBe('candidate');
    expect(result.basis).toBe('conflicting_git_remote_evidence');
    expect(result.include).toBe(false);
  });

  it('Uncertain / no evidence is reported explicitly', () => {
    const none = matchSessionToProject({}, identity);
    expect(none.confidence).toBe('none');
    expect(none.include).toBe(false);
    const uncertain = matchSessionToProject({ projectPathHints: ['/unrelated/hint'] }, identity);
    expect(uncertain.confidence).toBe('candidate');
    expect(uncertain.include).toBe(false);
  });

  it('Two directories with the same name do not share an identity', async () => {
    const otherRoot = await tempDir('aitimeline-samename-');
    const otherPath = path.join(otherRoot, 'fixture-project');
    const other = await buildProjectIdentity({ projectPath: otherPath, deviceId: 'device-other' });
    // No git repo: both are name-derived but with distinct paths -> still weak and distinct-safe.
    expect(other.project.identity_strong).toBe(false);
    const weakMerge = verifyProjectCompatibility([
      { projectId: other.project.project_id, basis: 'name', strong: false, name: 'fixture-project' },
      { projectId: other.project.project_id, basis: 'name', strong: false, name: 'fixture-project' },
    ]);
    expect(weakMerge.ok).toBe(false);
    expect(weakMerge.status).toBe('rejected');
    expect(weakMerge.reason).toMatch(/name-derived/);
  });
});

describe('Merge-time project identity verification', () => {
  it('rejects different project ids', () => {
    const result = verifyProjectCompatibility([
      { projectId: 'proj_a', basis: 'remote', strong: true, name: 'a' },
      { projectId: 'proj_b', basis: 'remote', strong: true, name: 'b' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('rejected');
    expect(result.reason).toMatch(/different project identities/);
  });

  it('accepts the same strong project across devices', () => {
    const result = verifyProjectCompatibility([
      { projectId: 'proj_shared', basis: 'remote', strong: true, name: 'p' },
      { projectId: 'proj_shared', basis: 'remote', strong: true, name: 'p' },
    ]);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('matched');
  });

  it('allows weak identities only after explicit confirmation', () => {
    const inputs = [
      { projectId: 'proj_weak', basis: 'name', strong: false, name: 'p' },
      { projectId: 'proj_weak', basis: 'name', strong: false, name: 'p' },
    ];
    expect(verifyProjectCompatibility(inputs).ok).toBe(false);
    const confirmed = verifyProjectCompatibility(inputs, { allowWeakIdentity: true });
    expect(confirmed.ok).toBe(true);
    expect(confirmed.status).toBe('weak_identity_confirmed');
  });
});
