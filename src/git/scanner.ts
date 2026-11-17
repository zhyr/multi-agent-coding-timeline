import { runGit, GIT_READ_ONLY_COMMANDS } from './git-cli.js';
import { collectPushEvidence } from './push-evidence.js';
import { normalizeRemoteUrl } from '../core/ids.js';
import type { GitCommitRecord, GitPushRecord } from '../schema/entities.js';

export interface GitRepositoryInfo {
  root: string;
  remoteUrl?: string;
  remoteName?: string;
  branch?: string;
  headSha?: string;
  rootCommitSha?: string;
  errors: string[];
  isGitRepository: boolean;
  hasCommits: boolean;
}

export interface GitScanResult {
  info: GitRepositoryInfo;
  commits: GitCommitRecord[];
  pushes: GitPushRecord[];
  warnings: string[];
  errors: string[];
}

/** Read-only inspection of repository metadata. Never changes git state. */
export async function inspectRepository(projectPath: string): Promise<GitRepositoryInfo> {
  const errors: string[] = [];
  const [toplevel, remote, branch, head, rootCommit] = await Promise.all([
    runGit(projectPath, GIT_READ_ONLY_COMMANDS.toplevel),
    runGit(projectPath, GIT_READ_ONLY_COMMANDS.remote),
    runGit(projectPath, GIT_READ_ONLY_COMMANDS.branch),
    runGit(projectPath, GIT_READ_ONLY_COMMANDS.head),
    runGit(projectPath, GIT_READ_ONLY_COMMANDS.rootCommit),
  ]);
  if (!toplevel.ok) {
    return {
      root: projectPath,
      errors: [`not a git repository or git unavailable: ${toplevel.stderr.trim()}`],
      isGitRepository: false,
      hasCommits: false,
    };
  }
  const root = toplevel.stdout.trim();
  if (!remote.ok) errors.push('no origin remote configured');
  if (!branch.ok) errors.push('could not determine current branch');
  const headSha = head.ok ? head.stdout.trim().split('\n')[0] : undefined;
  const rootCommitSha = rootCommit.ok ? rootCommit.stdout.trim().split('\n')[0] : undefined;
  if (!head.ok) errors.push(`repository has no commits or HEAD is unreadable: ${head.stderr.trim()}`);
  return {
    root,
    remoteUrl: remote.ok ? remote.stdout.trim().split('\n')[0] : undefined,
    remoteName: remote.ok ? 'origin' : undefined,
    branch: branch.ok ? branch.stdout.trim() : undefined,
    headSha: headSha && /^[0-9a-f]{40,64}$/i.test(headSha) ? headSha : undefined,
    rootCommitSha: rootCommitSha && /^[0-9a-f]{40,64}$/i.test(rootCommitSha) ? rootCommitSha : undefined,
    errors,
    isGitRepository: true,
    hasCommits: !!headSha,
  };
}

function parseBranchFromDecorations(decorations: string): string | undefined {
  const headMatch = /HEAD\s*->\s*([^,]+)/.exec(decorations);
  if (headMatch) return headMatch[1]!.trim();
  const first = decorations.split(',')[0]?.trim();
  if (!first || first.startsWith('tag:')) return undefined;
  return first.replace(/^origin\//, '');
}

function parseLog(stdout: string, projectId: string, deviceId: string, fallbackBranch?: string): GitCommitRecord[] {
  const commits: GitCommitRecord[] = [];
  for (const rawChunk of stdout.split('\x1e')) {
    const chunk = rawChunk.replace(/^\n+/, '');
    if (!chunk.trim()) continue;
    const newline = chunk.indexOf('\n');
    const header = (newline >= 0 ? chunk.slice(0, newline) : chunk).replace(/\r$/, '');
    const body = newline >= 0 ? chunk.slice(newline + 1) : '';
    const fields = header.split('\x1f');
    const sha = fields[0]?.trim() ?? '';
    if (!/^[0-9a-f]{40,64}$/i.test(sha)) continue;
    const parents = (fields[1] ?? '').trim().split(/\s+/).filter((p) => /^[0-9a-f]{40,64}$/i.test(p));
    let insertions = 0;
    let deletions = 0;
    const changedFiles: string[] = [];
    for (const line of body.split('\n')) {
      const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trimEnd());
      if (!match) continue;
      if (match[1] !== '-') insertions += Number(match[1]);
      if (match[2] !== '-') deletions += Number(match[2]);
      changedFiles.push(match[3]!);
    }
    commits.push({
      commit_sha: sha,
      parent_shas: parents,
      project_id: projectId,
      device_id: deviceId,
      branch: parseBranchFromDecorations(fields[8] ?? '') ?? fallbackBranch,
      message: fields[9]?.trim(),
      author_name: fields[4],
      author_email: fields[5],
      committer_name: fields[6],
      committer_email: fields[7],
      authored_at: fields[2],
      committed_at: fields[3],
      files_changed: changedFiles.length,
      insertions,
      deletions,
      changed_files: changedFiles.slice(0, 200),
      evidence_level: 'verified',
    });
  }
  return commits;
}

/** Full read-only Git scan: metadata, commits and push evidence. */
export async function scanGit(options: {
  projectPath: string;
  projectId: string;
  deviceId: string;
  maxCommits?: number;
}): Promise<GitScanResult> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const info = await inspectRepository(options.projectPath);
  errors.push(...info.errors.filter((e) => !e.startsWith('no origin remote')));
  if (!info.remoteUrl) warnings.push('repository has no origin remote; project identity falls back to repository identity or name');
  if (!info.isGitRepository) {
    return { info, commits: [], pushes: [], warnings, errors };
  }

  const [log, localBranches] = await Promise.all([
    runGit(info.root, GIT_READ_ONLY_COMMANDS.log),
    runGit(info.root, GIT_READ_ONLY_COMMANDS.localBranches),
  ]);
  if (!log.ok) {
    errors.push(`git log failed: ${log.stderr.trim()}`);
    return { info, commits: [], pushes: [], warnings, errors };
  }
  // Only attribute undecorated commits to the checked-out branch when the
  // repository has exactly one local branch; otherwise membership is ambiguous.
  const soleBranch = localBranches.ok
    ? localBranches.stdout.split('\n').map((b) => b.trim()).filter(Boolean)
    : [];
  const fallbackBranch = soleBranch.length === 1 && soleBranch[0] === info.branch ? info.branch : undefined;
  let commits = parseLog(log.stdout, options.projectId, options.deviceId, fallbackBranch);
  if (options.maxCommits && commits.length > options.maxCommits) {
    warnings.push(`commit list truncated from ${commits.length} to ${options.maxCommits}`);
    commits = commits.slice(0, options.maxCommits);
  }
  commits.sort((a, b) => (a.committed_at ?? '').localeCompare(b.committed_at ?? '') || a.commit_sha.localeCompare(b.commit_sha));

  const push = await collectPushEvidence({
    cwd: info.root,
    projectId: options.projectId,
    deviceId: options.deviceId,
    remoteName: info.remoteName,
    remoteUrl: info.remoteUrl ? normalizeRemoteUrl(info.remoteUrl) : undefined,
  });
  warnings.push(push.note);
  return { info, commits, pushes: push.pushes, warnings, errors };
}
