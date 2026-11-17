import { describe, it, expect } from 'vitest';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { writePackage, readPackage, validatePackage, validateData } from '../src/package/index.js';
import { ActivityEventSchema, ManifestSchema } from '../src/schema/entities.js';
import { makeTimelineData, makeEvent, tempDir } from './helpers/fixtures.js';

describe('Timeline schema and package', () => {
  it('generates a valid package with integrity checksums', async () => {
    const dir = await tempDir();
    const data = makeTimelineData();
    const written = await writePackage(path.join(dir, 'pkg'), data);
    expect(written.files).toContain('manifest.json');
    expect(written.files).toContain('integrity/checksums.sha256');
    expect(written.checksums.length).toBeGreaterThan(10);
    const result = await validatePackage(path.join(dir, 'pkg'));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checksums?.ok).toBe(true);
  });

  it('accepts an empty package (zero events)', async () => {
    const dir = await tempDir();
    await writePackage(path.join(dir, 'empty'), makeTimelineData());
    const result = await validatePackage(path.join(dir, 'empty'));
    expect(result.ok).toBe(true);
    expect(result.stats.events).toBe(0);
  });

  it('rejects missing required ActivityEvent fields', () => {
    const bad = makeEvent();
    delete (bad as Partial<typeof bad>).event_id;
    expect(ActivityEventSchema.safeParse(bad).success).toBe(false);
    const badTime = makeEvent({ time: { observed_at: 'not-a-date' } });
    expect(ActivityEventSchema.safeParse(badTime).success).toBe(false);
  });

  it('rejects missing required manifest fields', () => {
    const bad = { ...makeTimelineData().manifest };
    delete (bad as Partial<typeof bad>).project_id;
    expect(ManifestSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unsupported schema version', async () => {
    const dir = await tempDir();
    const data = makeTimelineData();
    data.manifest.schema_version = '99.0.0';
    const pkg = path.join(dir, 'pkg');
    await writePackage(pkg, data);
    const result = await validatePackage(pkg);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/schema version/i);
  });

  it('rejects invalid JSONL records and reports the malformed line', async () => {
    const dir = await tempDir();
    const pkg = path.join(dir, 'pkg');
    const data = makeTimelineData({ events: [makeEvent()] });
    await writePackage(pkg, data);
    const eventsFile = path.join(pkg, 'events.jsonl');
    await writeFile(eventsFile, (await readFile(eventsFile, 'utf8')) + '{broken json\n' + '{"event_id":"ghost"}\n');
    const result = await validatePackage(pkg);
    expect(result.ok).toBe(false);
    expect(result.readIssues.some((i) => i.file === 'events.jsonl')).toBe(true);
    expect(result.errors.join(' ')).toMatch(/events|jsonl|sha256/i);
  });

  it('detects a checksum mismatch after tampering', async () => {
    const dir = await tempDir();
    const pkg = path.join(dir, 'pkg');
    await writePackage(pkg, makeTimelineData());
    const manifestPath = path.join(pkg, 'manifest.json');
    await writeFile(manifestPath, (await readFile(manifestPath, 'utf8')) + '\n');
    const result = await validatePackage(pkg);
    expect(result.ok).toBe(false);
    expect(result.checksums?.mismatched.map((m) => m.path)).toContain('manifest.json');
  });

  it('detects an unlisted extra file', async () => {
    const dir = await tempDir();
    const pkg = path.join(dir, 'pkg');
    await writePackage(pkg, makeTimelineData());
    await writeFile(path.join(pkg, 'extra.txt'), 'unexpected');
    const result = await validatePackage(pkg);
    expect(result.ok).toBe(false);
    expect(result.checksums?.unlisted).toContain('extra.txt');
  });

  it('rejects duplicate event ids and dangling session references', () => {
    const e1 = makeEvent();
    const data = makeTimelineData({ events: [e1, { ...e1 }] });
    expect(validateData(data).errors.join(' ')).toMatch(/event id uniqueness/);
    const dangling = makeTimelineData({ events: [makeEvent({ session_id: 'sess_missing' })] });
    expect(validateData(dangling).errors.join(' ')).toMatch(/session reference integrity/);
  });

  it('round-trips a full package without losing records or unknown fields', async () => {
    const dir = await tempDir();
    const event = makeEvent({ extra_future_field: 'keep-me' } as never);
    const data = makeTimelineData({
      events: [event],
      sessions: [{
        session_id: 'sess_1', project_id: 'proj_fixture', device_id: 'device-fixture',
        agent_id: 'codex', native_session_id: 'native-1', source_path: 'a.jsonl',
        source_path_identity: 'codex/a.jsonl', event_count: 1, match_confidence: 'exact',
      }],
      tasks: [{
        task_id: 'task_1', project_id: 'proj_fixture', session_id: 'sess_1',
        device_id: 'device-fixture', agent_id: 'codex', evidence_level: 'agent_reported',
      }],
      agents: [{ agent_id: 'codex', agent_name: 'OpenAI Codex', adapter_version: '1.0.0', verification: 'verified' }],
      commits: [{
        commit_sha: 'a'.repeat(40), parent_shas: [], project_id: 'proj_fixture',
        device_id: 'device-fixture', evidence_level: 'verified',
      }],
    });
    data.events[0]!.session_id = 'sess_1';
    data.manifest.event_count = 1;
    data.manifest.session_count = 1;
    data.manifest.agent_count = 1;
    data.manifest.git_commit_count = 1;

    const first = path.join(dir, 'first');
    const second = path.join(dir, 'second');
    await writePackage(first, data);
    const read = await readPackage(first);
    expect(read.data.events[0]!.extra_future_field).toBe('keep-me');
    await writePackage(second, read.data);
    const a = await readPackage(first);
    const b = await readPackage(second);
    expect(b.data.events).toEqual(a.data.events);
    expect(b.data.sessions).toEqual(a.data.sessions);
    expect(b.data.project).toEqual(a.data.project);
    expect(b.data.manifest).toEqual(a.data.manifest);
    expect((await validatePackage(second)).ok).toBe(true);
  });

  it('refuses to overwrite a non-empty output directory without force', async () => {
    const dir = await tempDir();
    const pkg = path.join(dir, 'pkg');
    await writePackage(pkg, makeTimelineData());
    await expect(writePackage(pkg, makeTimelineData())).rejects.toThrow(/not empty/i);
    await expect(writePackage(pkg, makeTimelineData(), { overwrite: true })).resolves.toBeDefined();
    await rm(dir, { recursive: true, force: true });
  });
});
