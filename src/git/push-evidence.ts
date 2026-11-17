import { runGit, GIT_READ_ONLY_COMMANDS } from './git-cli.js';
import { shortId } from '../core/hash.js';
import type { GitPushRecord } from '../schema/entities.js';

export interface PushEvidenceInput {
  reflogHasPushEntry: boolean;
  remoteTrackingRefCount: number;
  hookLogConfirmsPush: boolean;
  remoteName?: string;
  remoteUrl?: string;
  ref?: string;
  commitSha?: string;
}

export interface PushAssessment {
  level: 'verified' | 'inferred' | 'unknown';
  basis: string;
}

/**
 * Pure, testable classification. A commit alone NEVER implies a push.
 * Only an explicit execution/hook record yields `verified`; a remote tracking
 * ref yields `inferred` because it can also be produced by a fetch or pull.
 */
export function classifyPushEvidence(input: PushEvidenceInput): PushAssessment {
  if (input.hookLogConfirmsPush) {
    return { level: 'verified', basis: 'git hook / execution log explicitly records a completed push' };
  }
  if (input.reflogHasPushEntry) {
    return { level: 'verified', basis: 'git reflog entry explicitly records a push' };
  }
  if (input.remoteTrackingRefCount > 0) {
    return {
      level: 'inferred',
      basis: 'remote tracking ref exists; presence does not prove this device performed the push',
    };
  }
  return { level: 'unknown', basis: 'no push evidence observed; commits alone do not imply a push' };
}

export async function collectPushEvidence(options: {
  cwd: string;
  projectId: string;
  deviceId: string;
  remoteName?: string;
  remoteUrl?: string;
}): Promise<{ pushes: GitPushRecord[]; note: string }> {
  const [refs, reflog] = await Promise.all([
    runGit(options.cwd, GIT_READ_ONLY_COMMANDS.remoteRefs),
    runGit(options.cwd, GIT_READ_ONLY_COMMANDS.reflog),
  ]);
  const refLines = refs.ok ? refs.stdout.split('\n').filter((l) => l.trim()) : [];
  const reflogText = reflog.ok ? reflog.stdout : '';
  const reflogHasPush = /\bpush(?:ed|ing)?\b/i.test(reflogText);
  const assessment = classifyPushEvidence({
    reflogHasPushEntry: reflogHasPush,
    remoteTrackingRefCount: refLines.length,
    hookLogConfirmsPush: false, // no hooks are installed or read by this tool
    remoteName: options.remoteName,
    remoteUrl: options.remoteUrl,
  });

  const firstRef = refLines[0]?.split('\x1f') ?? [];
  const ref = firstRef[0] ?? undefined;
  const commitSha = firstRef[1] ?? undefined;
  const push: GitPushRecord = {
    push_id: shortId('push', options.projectId, options.deviceId, assessment.level, ref ?? 'none'),
    project_id: options.projectId,
    device_id: options.deviceId,
    remote_name: options.remoteName,
    remote_url: options.remoteUrl,
    ref,
    commit_sha: commitSha && /^[0-9a-f]{40,64}$/i.test(commitSha) ? commitSha : undefined,
    evidence_level: assessment.level,
    basis: assessment.basis,
    observed_at: new Date().toISOString(),
  };
  return {
    pushes: [push],
    note: `push evidence level=${assessment.level}: ${assessment.basis}`,
  };
}
