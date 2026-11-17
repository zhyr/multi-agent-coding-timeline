import path from 'node:path';
import { computeProjectId, normalizeRemoteUrl } from '../core/ids.js';
import { shortId } from '../core/hash.js';
import { inspectRepository, type GitRepositoryInfo } from '../git/scanner.js';
import type { TimelineProject } from '../schema/entities.js';

export interface ProjectIdentity {
  project: TimelineProject;
  worktreePaths: string[];
  remoteUrls: string[];
  repositoryIdentity?: string;
  projectName: string;
  aliases: string[];
  gitInfo: GitRepositoryInfo;
}

/** Build the stable project identity used by all three operating modes. */
export async function buildProjectIdentity(options: {
  projectPath: string;
  deviceId: string;
  explicitProjectId?: string;
  explicitRemoteUrl?: string;
}): Promise<ProjectIdentity> {
  const gitInfo = await inspectRepository(path.resolve(options.projectPath));
  const requestedRoot = path.resolve(options.projectPath);
  const root = path.resolve(gitInfo.isGitRepository ? gitInfo.root : options.projectPath);
  // Git reports the canonical real path; the user-supplied path may use a
  // symlinked prefix (e.g. /var vs /private/var on macOS). Both are the same
  // worktree and must match session cwd evidence.
  const worktreePaths = [...new Set([root, requestedRoot])];
  const projectName = path.basename(root);
  const canonicalRemote = normalizeRemoteUrl(options.explicitRemoteUrl ?? gitInfo.remoteUrl ?? '');
  const repositoryIdentity = gitInfo.rootCommitSha;
  const computed = computeProjectId({
    canonicalRemoteUrl: canonicalRemote || undefined,
    repositoryIdentity,
    projectName,
    explicitProjectId: options.explicitProjectId,
  });
  const remoteUrls = canonicalRemote ? [canonicalRemote] : [];
  const repositoryId = shortId('repo', canonicalRemote || repositoryIdentity || root);
  const worktreeId = shortId('work', options.deviceId, root);

  const project: TimelineProject = {
    project_id: computed.projectId,
    project_name: projectName,
    canonical_remote_url: canonicalRemote || undefined,
    identity_basis: computed.basis,
    identity_strong: computed.strong,
    repositories: [
      {
        repository_id: repositoryId,
        remote_urls: remoteUrls,
        repository_identity: repositoryIdentity,
      },
    ],
    worktrees: [
      {
        worktree_id: worktreeId,
        repository_id: repositoryId,
        device_id: options.deviceId,
        path: root,
        branch: gitInfo.branch,
      },
    ],
    aliases: [projectName.toLowerCase()],
  };

  return {
    project,
    worktreePaths,
    remoteUrls,
    repositoryIdentity,
    projectName,
    aliases: project.aliases ?? [],
    gitInfo,
  };
}
