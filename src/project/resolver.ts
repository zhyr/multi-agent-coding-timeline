import path from 'node:path';
import type { MatchConfidence } from '../core/constants.js';
import { normalizeRemoteUrl } from '../core/ids.js';
import type { ProjectEvidence } from '../adapters/types.js';
import type { ProjectIdentity } from './identity.js';

export interface MatchResult {
  confidence: MatchConfidence;
  basis: string;
  reasons: string[];
  /** Candidate matches must not enter the official timeline by default. */
  include: boolean;
}

export function normalizePath(input: string): string {
  let out = path.resolve(input.trim()).replace(/[\\/]+$/, '');
  if (process.platform === 'darwin' || process.platform === 'win32') out = out.toLowerCase();
  return out;
}

/** True only for a proper descendant (equality is handled as an exact match). */
function isStrictlyWithin(child: string, parent: string): boolean {
  return child !== parent && child.startsWith(parent + path.sep);
}

function basename(input: string): string {
  const cleaned = input.replace(/[\\/]+$/, '');
  return path.basename(cleaned).toLowerCase();
}

/**
 * Evidence-based project resolution. Never treats name similarity alone as an
 * exact match; never silently includes candidate-grade sessions.
 */
export function matchSessionToProject(
  evidence: ProjectEvidence,
  identity: ProjectIdentity,
): MatchResult {
  const reasons: string[] = [];
  const hints = (evidence.projectPathHints ?? []).filter(Boolean);
  const cwd = evidence.cwd ? normalizePath(evidence.cwd) : undefined;
  const worktrees = identity.worktreePaths.map(normalizePath);
  const remote = evidence.gitRemote ? normalizeRemoteUrl(evidence.gitRemote) : '';
  const hintPaths = hints.map((h) => ({ raw: h, normalized: normalizePath(h) }));

  // --- Exact evidence ---
  if (remote && identity.remoteUrls.includes(remote)) {
    return {
      confidence: 'exact',
      basis: 'git_remote_url_match',
      reasons: [`session git remote ${remote} equals canonical project remote`],
      include: true,
    };
  }
  if (remote && identity.remoteUrls.length > 0 && !identity.remoteUrls.includes(remote)) {
    return {
      confidence: 'candidate',
      basis: 'conflicting_git_remote_evidence',
      reasons: [`session remote ${remote} disagrees with project remote ${identity.remoteUrls.join(',')}`],
      include: false,
    };
  }
  if (cwd && worktrees.some((w) => w === cwd)) {
    return {
      confidence: 'exact',
      basis: 'worktree_path_match',
      reasons: [`session cwd ${cwd} equals project worktree`],
      include: true,
    };
  }
  if (evidence.nativeProjectId && evidence.nativeProjectId === identity.project.project_id) {
    return {
      confidence: 'exact',
      basis: 'native_project_id_match',
      reasons: ['agent-native project id equals resolved project id'],
      include: true,
    };
  }

  // --- Strong evidence: a precise path relationship ---
  // A session cwd strictly inside the project worktree, or an agent path hint
  // that equals the worktree, identifies the project. An ancestor cwd
  // (e.g. the user's home directory) is NOT evidence that the session belongs
  // to a project nested below it, so it is downgraded to candidate.
  const pathSignals: string[] = [];
  if (cwd && worktrees.some((w) => isStrictlyWithin(cwd, w))) {
    pathSignals.push('cwd is inside the project worktree');
  }
  const exactHint = hintPaths.find((h) => worktrees.some((w) => h.normalized === w));
  if (exactHint) pathSignals.push(`agent project path hint matches worktree (${exactHint.raw})`);
  if (pathSignals.length >= 1) {
    return {
      confidence: 'strong',
      basis: 'path_signal_match',
      reasons: pathSignals,
      include: true,
    };
  }

  // --- Candidate: weak / single / name-only signals ---
  const name = identity.projectName.toLowerCase();
  if (cwd && worktrees.some((w) => isStrictlyWithin(w, cwd))) {
    reasons.push(`cwd ${cwd} is an ancestor of the project worktree`);
  }
  if (cwd && worktrees.some((w) => basename(cwd) === basename(w))) {
    reasons.push('cwd basename equals project worktree basename');
  }
  const nameHint = hints.find((h) => basename(h) === name || h.toLowerCase().includes(name));
  if (nameHint) reasons.push(`weak path hint contains project name (${nameHint})`);
  if (hints.length > 0 && reasons.length === 0) reasons.push('unverified path hint only');
  if (cwd && reasons.length === 0) reasons.push(`cwd ${cwd} does not overlap project worktree`);
  if (reasons.length === 0) reasons.push('no usable project association evidence');

  const hasAnyEvidence = !!cwd || hints.length > 0 || !!evidence.nativeProjectId || !!remote;
  return {
    confidence: hasAnyEvidence ? 'candidate' : 'none',
    basis: reasons[0] ?? 'no_evidence',
    reasons,
    include: false,
  };
}

/** Used by the merge engine. Only strong identities may be merged silently. */
export function verifyProjectCompatibility(
  inputs: Array<{ projectId: string; basis: string; strong: boolean; remoteUrl?: string; name: string }>,
  options: { allowWeakIdentity?: boolean } = {},
): { ok: boolean; status: 'matched' | 'weak_identity_confirmed' | 'rejected'; reason: string } {
  if (inputs.length === 0) return { ok: false, status: 'rejected', reason: 'no input timelines' };
  const ids = new Set(inputs.map((i) => i.projectId));
  if (ids.size > 1) {
    return { ok: false, status: 'rejected', reason: `different project identities: ${[...ids].join(', ')}` };
  }
  const weak = inputs.some((i) => !i.strong);
  if (weak && !options.allowWeakIdentity) {
    return {
      ok: false,
      status: 'rejected',
      reason: 'project identity is name-derived; pass --allow-weak-identity only after manual confirmation',
    };
  }
  return {
    ok: true,
    status: weak ? 'weak_identity_confirmed' : 'matched',
    reason: weak ? 'weak identity explicitly confirmed by user' : 'all inputs share a strong project identity',
  };
}
