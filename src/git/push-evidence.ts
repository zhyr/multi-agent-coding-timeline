import { runGit, GIT_READ_ONLY_COMMANDS } from './git-cli.js';
import { shortId } from '../core/hash.js';
import type { GitPushRecord } from '../schema/entities.js';

export interface PushEvidenceInput {
  /** A remote must be configured before any push can be verified. */
  remoteConfigured: boolean;
  /**
   * Remote-tracking refs whose reflog entry is exactly `update by push`.
   * Commit subjects and unrelated reflog text are never inspected.
   */
  pushReflogRefs: string[];
  remoteTrackingRefCount: number;
  hookLogConfirmsPush: boolean;
}

export interface PushAssessment {
  level: 'verified' | 'inferred' | 'unknown';
  basis: string;
}

/**
 * Pure, testable classification. A commit alone NEVER implies a push.
 * Only an explicit push record (`update by push` reflog entry or an installed
 * hook log) on a repository with a configured remote yields `verified`.
 * A remote tracking ref alone yields `inferred`, because it can also be
 * produced by a fetch or pull.
 */
export function classifyPushEvidence(input: PushEvidenceInput): PushAssessment {
  if (!input.remoteConfigured) {
    return { level: 'unknown', basis: 'no configured remote; a push cannot be verified without a remote' };
  }
  if (input.hookLogConfirmsPush) {
    return { level: 'verified', basis: 'git hook / execution log explicitly records a completed push' };
  }
  if (input.pushReflogRefs.length > 0) {
    return {
      level: 'verified',
      basis: `git reflog records a push for ${input.pushReflogRefs[0]} (update by push)`,
    };
  }
  if (input.remoteTrackingRefCount > 0) {
    return {
      level: 'inferred',
      basis: 'remote tracking ref exists; presence does not prove this device performed the push',
    };
  }
  return { level: 'unknown', basis: 'no push evidence observed; commits alone do not imply a push' };
}

interface ReflogEntry {
  sha: string;
  subject: string;
  selector: string;
}

/** `refs/remotes/origin/main@{2026-11-17T16:25:47+08:00}` -> ref + UTC timestamp. */
function splitSelector(selector: string): { ref: string; occurredAt?: string } {
  const match = /^(.*?)@\{(.+)\}$/.exec(selector.trim());
  const ref = (match ? match[1] : selector).trim();
  const rawDate = match?.[2];
  if (!rawDate) return { ref };
  const parsed = new Date(rawDate);
  if (Number.isNaN(parsed.getTime())) return { ref };
  return { ref, occurredAt: parsed.toISOString() };
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
  const refEntries = (refs.ok ? refs.stdout.split('\n') : [])
    .filter((line) => line.trim())
    .map((line) => {
      const [ref, sha] = line.split('\t');
      return { ref: ref?.trim() ?? '', sha: sha?.trim() ?? '' };
    })
    .filter((entry) => entry.ref && /^[0-9a-f]{40,64}$/i.test(entry.sha));

  const reflogEntries: ReflogEntry[] = (reflog.ok ? reflog.stdout.split('\n') : [])
    .filter((line) => line.trim())
    .map((line) => {
      const [sha = '', subject = '', selector = ''] = line.split('\x1f');
      return { sha: sha.trim(), subject: subject.trim(), selector: selector.trim() };
    });

  // Only a reflog entry on a remote-tracking ref whose message is exactly
  // `update by push` proves that this repository performed a push. Commit
  // subjects (which may contain the word "push") are never considered.
  const pushEntries = reflogEntries
    .filter(
      (entry) =>
        entry.subject === 'update by push' &&
        entry.selector.startsWith('refs/remotes/') &&
        /^[0-9a-f]{40,64}$/i.test(entry.sha),
    )
    .map((entry) => ({ ...entry, ...splitSelector(entry.selector) }));

  const remoteConfigured = !!(options.remoteUrl || options.remoteName);
  const assessment = classifyPushEvidence({
    remoteConfigured,
    pushReflogRefs: [...new Set(pushEntries.map((entry) => entry.ref))],
    remoteTrackingRefCount: refEntries.length,
    hookLogConfirmsPush: false, // no hooks are installed or read by this tool
  });

  const observedAt = new Date().toISOString();
  const common = {
    project_id: options.projectId,
    device_id: options.deviceId,
    remote_name: options.remoteName,
    remote_url: options.remoteUrl,
    observed_at: observedAt,
  };

  let pushes: GitPushRecord[];
  if (pushEntries.length > 0) {
    // One record per distinct (ref, commit, reflog timestamp). Pushes are not
    // collapsed into a single synthetic event, and their time is the reflog
    // time, never the time at which the scan happened to run.
    const seen = new Set<string>();
    pushes = [];
    for (const entry of pushEntries) {
      const key = `${entry.ref}\u0000${entry.sha}\u0000${entry.occurredAt ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pushes.push({
        ...common,
        push_id: shortId(
          'push',
          options.projectId,
          options.deviceId,
          'verified',
          entry.ref,
          entry.sha,
          entry.occurredAt ?? 'none',
        ),
        ref: entry.ref,
        commit_sha: entry.sha,
        evidence_level: 'verified',
        basis: `git reflog records a push to ${entry.ref} (update by push)`,
        occurred_at: entry.occurredAt,
      });
    }
  } else {
    // Inferred/unknown evidence has no trustworthy occurrence time; the
    // normalizer will use observed_at_fallback instead of inventing one.
    const first = refEntries[0];
    pushes = [
      {
        ...common,
        push_id: shortId(
          'push',
          options.projectId,
          options.deviceId,
          assessment.level,
          first?.ref ?? 'none',
          first?.sha ?? 'none',
        ),
        ref: first?.ref,
        commit_sha: first && /^[0-9a-f]{40,64}$/i.test(first.sha) ? first.sha : undefined,
        evidence_level: assessment.level,
        basis: assessment.basis,
      },
    ];
  }
  pushes.sort((a, b) => a.push_id.localeCompare(b.push_id));
  return {
    pushes,
    note: `push evidence level=${assessment.level}: ${assessment.basis} (${pushes.length} record(s))`,
  };
}
