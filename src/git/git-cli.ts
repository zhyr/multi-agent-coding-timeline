import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Execute a strictly read-only git command. No shell is used and arguments are
 * passed as an array, so project paths cannot be interpreted as commands.
 * This module never invokes write operations, hooks, config changes or fetch.
 */
export async function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['-C', cwd, ...args], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    });
    return { ok: true, stdout: String(stdout), stderr: String(stderr ?? ''), code: 0 };
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    return {
      ok: false,
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : e.message ?? 'git failed',
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

/** Commands used by the scanner. Kept here so read-only behaviour is auditable in one place. */
export const GIT_READ_ONLY_COMMANDS = {
  toplevel: ['rev-parse', '--show-toplevel'],
  remote: ['remote', 'get-url', 'origin'],
  remotes: ['remote', '-v'],
  branch: ['branch', '--show-current'],
  head: ['rev-parse', 'HEAD'],
  rootCommit: ['rev-list', '--max-parents=0', '--all'],
  log: [
    'log',
    '--all',
    '--date-order',
    '--numstat',
    '--no-renames',
    '--format=%x1e%H%x1f%P%x1f%aI%x1f%cI%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%D%x1f%s',
  ],
  remoteRefs: ['for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/remotes'],
  localBranches: ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
  // %gD with --date=iso-strict yields `refs/remotes/<name>@{<ISO-8601>}`:
  // the selector identifies the ref and the timestamp of the reflog entry.
  reflog: ['reflog', '--all', '--date=iso-strict', '--format=%H%x1f%gs%x1f%gD'],
  status: ['status', '--porcelain=v1'],
} as const;
