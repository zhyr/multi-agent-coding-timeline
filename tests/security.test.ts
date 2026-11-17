import { describe, it, expect } from 'vitest';
import { readdir, readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { redactSecrets, detectSecrets, applyContentMode, FULL_EXPORT_WARNING } from '../src/core/redaction.js';
import { resolveWithin, isWithin, walkFiles } from '../src/core/fs.js';
import { parseLines } from '../src/adapters/util.js';
import { GIT_READ_ONLY_COMMANDS } from '../src/git/git-cli.js';
import { tempDir } from './helpers/fixtures.js';

async function allSourceFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function rec(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await rec(p);
      else if (entry.name.endsWith('.ts')) out.push(p);
    }
  }
  await rec(root);
  return out;
}

describe('Secret redaction and data minimization', () => {
  it('redacts common credential shapes', () => {
    const text = [
      'OPENAI_API_KEY=sk-abcdefghijklmnop1234567890',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop',
      'token: "ghp_abcdefghijklmnopqrstuvwxyz1234"',
      'password=hunter2supersecret',
      'postgres://admin:supersecret@db.internal:5432/app',
      'AKIAIOSFODNN7EXAMPLE',
    ].join('\n');
    const result = redactSecrets(text);
    expect(result.kinds.length).toBeGreaterThanOrEqual(4);
    expect(result.text).not.toContain('sk-abcdefghijklmnop1234567890');
    expect(result.text).not.toContain('hunter2supersecret');
    expect(result.text).not.toContain('supersecret@db.internal');
    expect(result.text).toContain('[REDACTED');
  });

  it('redacts PEM private key blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecret\n-----END RSA PRIVATE KEY-----';
    expect(redactSecrets(pem).text).toBe('[REDACTED:private_key]');
    expect(detectSecrets(pem)).toContain('private_key');
  });

  it('does not mangle ordinary source code', () => {
    const code = 'const total = computeSum(a, b); // returns a number\nexport function main() { return total; }';
    expect(redactSecrets(code).text).toBe(code);
    expect(detectSecrets(code)).toEqual([]);
  });

  it('metadata_only exports no text at all', () => {
    const fields = applyContentMode('please fix the parser with sk-abcdefghijklmnop1234567890', 'metadata_only');
    expect(fields.content).toBeUndefined();
    expect(fields.content_summary).toBeUndefined();
    expect(fields.content_length).toBeGreaterThan(0);
  });

  it('summary mode bounds and redacts content', () => {
    const long = 'x'.repeat(1000);
    const fields = applyContentMode(long, 'summary');
    expect(fields.content).toBeUndefined();
    expect(fields.content_summary!.length).toBeLessThan(300);
    expect(fields.content_summary).toContain('truncated');
  });

  it('full mode is explicit, redacted and warned about', () => {
    const fields = applyContentMode('api_key=sk-abcdefghijklmnop1234567890', 'full');
    expect(fields.content).toContain('[REDACTED');
    expect(fields.redaction_kinds.length).toBeGreaterThan(0);
    expect(FULL_EXPORT_WARNING).toMatch(/source code|credentials/);
  });
});

describe('Path traversal, symlink and malformed input handling', () => {
  it('rejects traversal outside the base directory', () => {
    const base = '/tmp/aitimeline-safe';
    expect(resolveWithin(base, 'sessions/a.jsonl')).toBe('/tmp/aitimeline-safe/sessions/a.jsonl');
    expect(() => resolveWithin(base, '../../etc/passwd')).toThrow(/traversal/i);
    expect(isWithin(base, '../outside')).toBe(false);
    expect(isWithin(base, 'nested/file')).toBe(true);
  });

  it('skips symlinks by default during source walks', async () => {
    const root = await tempDir('aitimeline-symlink-');
    const outside = path.join(root, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'secret.jsonl'), '{"a":1}\n');
    const source = path.join(root, 'source');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'real.jsonl'), '{"a":2}\n');
    await symlink(path.join(outside, 'secret.jsonl'), path.join(source, 'link.jsonl'));
    const walked = await walkFiles(source);
    expect(walked.files).toEqual(['real.jsonl']);
    expect(walked.skippedSymlinks).toBe(1);
  });

  it('isolates malformed JSONL lines without throwing', () => {
    const issues: Array<{ line: number; reason: string }> = [];
    const records = parseLines('{"ok":1}\n{broken\n\n{"ok":2}', issues);
    expect(records).toHaveLength(2);
    expect(issues.length).toBeGreaterThanOrEqual(2);
    expect(issues.some((i) => i.reason.includes('newline'))).toBe(true);
  });
});

describe('Static security guarantees', () => {
  it('contains no network upload or telemetry calls', async () => {
    const files = await allSourceFiles(path.resolve('src'));
    const forbidden = /\b(fetch\s*\(|https?\.request\s*\(|axios|XMLHttpRequest|node-fetch|telemetry|sentry|analytics)\b/;
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (forbidden.test(text)) offenders.push(path.basename(file));
    }
    expect(offenders).toEqual([]);
  });

  it('contains no background watchers, hooks or process injection', async () => {
    const files = await allSourceFiles(path.resolve('src'));
    const forbidden = /\b(fs\.watch|watchFile\s*\(|setInterval\s*\(|chokidar|core\.hook|installHook|process\.on\s*\(\s*['"]SIGUSR)/;
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (forbidden.test(text)) offenders.push(path.basename(file));
    }
    expect(offenders).toEqual([]);
  });

  it('uses only read-only Git commands', () => {
    const writeCommands = ['push', 'commit', 'checkout', 'reset', 'merge', 'rebase', 'config', 'hook', 'fetch', 'pull', 'clean', 'stash'];
    for (const [name, args] of Object.entries(GIT_READ_ONLY_COMMANDS)) {
      expect(writeCommands).not.toContain(String(args[0]));
      expect(name).toBeTruthy();
    }
  });
});
