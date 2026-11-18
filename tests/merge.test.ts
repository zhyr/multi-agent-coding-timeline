import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { runMerge } from '../src/merge/engine.js';
import { deduplicateEvents } from '../src/merge/dedup.js';
import { writePackage, validatePackage } from '../src/package/index.js';
import { computeConflictEventId, computeEventId } from '../src/core/ids.js';
import type { TimelineData } from '../src/package/model.js';
import type { ActivityEvent } from '../src/schema/entities.js';
import { makeTimelineData, makeEvent, tempDir } from './helpers/fixtures.js';

function ev(key: string, extra: Partial<ActivityEvent> = {}): ActivityEvent {
  return makeEvent({ dedup_key: key, ...extra });
}

interface InputSpec {
  projectId?: string;
  deviceId?: string;
  timelineId?: string;
  events: ActivityEvent[];
  weak?: boolean;
  noDevices?: boolean;
  schemaVersion?: string;
}

function buildInput(spec: InputSpec): TimelineData {
  const base = makeTimelineData();
  const projectId = spec.projectId ?? 'proj_shared';
  const deviceId = spec.deviceId ?? 'device-a';
  const sourceDevices = spec.noDevices ? [] : [deviceId];
  const events = spec.events.map((e) => ({ ...e, project_id: projectId, device_id: deviceId }));
  return makeTimelineData({
    manifest: {
      ...base.manifest,
      timeline_id: spec.timelineId ?? `tln_${deviceId}`,
      project_id: projectId,
      source_devices: sourceDevices,
      project_identity_basis: spec.weak ? 'name' : 'remote',
      project_identity_strong: !spec.weak,
      schema_version: spec.schemaVersion ?? '1.0.0',
    },
    project: {
      ...base.project,
      project_id: projectId,
      identity_basis: spec.weak ? 'name' : 'remote',
      identity_strong: !spec.weak,
      canonical_remote_url: spec.weak ? undefined : 'https://github.com/example/shared',
    },
    devices: spec.noDevices ? [] : [{ device_id: deviceId, role: 'source', scanner_device_id: deviceId }],
    events,
  });
}

async function createInput(root: string, name: string, spec: InputSpec): Promise<string> {
  const dir = path.join(root, name);
  await writePackage(dir, buildInput(spec));
  return dir;
}

describe('Multi-device Timeline Merge', () => {
  it('A+B merge produces a valid unified package with two source devices', async () => {
    const root = await tempDir('aitimeline-merge-ab-');
    const a = await createInput(root, 'A', { deviceId: 'device-a', events: [ev('a1'), ev('a2')] });
    const b = await createInput(root, 'B', { deviceId: 'device-b', events: [ev('b1'), ev('b2')] });
    const out = path.join(root, 'merged');
    const result = await runMerge({ inputs: [a, b], output: out });
    expect(result.report.input_timelines).toBe(2);
    expect(result.report.source_devices).toBe(2);
    expect(result.data.events).toHaveLength(4);
    expect(result.data.manifest.operation).toBe('merge');
    expect(result.data.manifest.source_devices.sort()).toEqual(['device-a', 'device-b']);
    expect((await validatePackage(out)).ok).toBe(true);
    expect(result.report.project_identity_status).toBe('matched');
  });

  it('A+B+C merge scales to N inputs', async () => {
    const root = await tempDir('aitimeline-merge-abc-');
    const a = await createInput(root, 'A', { deviceId: 'device-a', events: [ev('a1')] });
    const b = await createInput(root, 'B', { deviceId: 'device-b', events: [ev('b1')] });
    const c = await createInput(root, 'C', { deviceId: 'device-c', events: [ev('c1')] });
    const result = await runMerge({ inputs: [a, b, c], output: path.join(root, 'merged') });
    expect(result.data.events).toHaveLength(3);
    expect(result.report.source_devices).toBe(3);
  });

  it('eliminates duplicate events from repeated imports', async () => {
    const root = await tempDir('aitimeline-merge-dup-');
    const a = await createInput(root, 'A', { deviceId: 'device-a', events: [ev('common'), ev('a1')] });
    const b = await createInput(root, 'B', { deviceId: 'device-b', events: [ev('common'), ev('b1')] });
    const result = await runMerge({ inputs: [a, b], output: path.join(root, 'merged') });
    expect(result.data.events).toHaveLength(3);
    expect(result.report.duplicate_events).toBe(1);
    expect(new Set(result.data.events.map((e) => e.event_id)).size).toBe(3);
  });

  it('is idempotent: re-merging the same inputs and the merged result adds nothing', async () => {
    const root = await tempDir('aitimeline-merge-idem-');
    const a = await createInput(root, 'A', { deviceId: 'device-a', events: [ev('a1'), ev('shared')] });
    const b = await createInput(root, 'B', { deviceId: 'device-b', events: [ev('b1'), ev('shared')] });
    const first = await runMerge({ inputs: [a, b], output: path.join(root, 'm1') });
    const second = await runMerge({ inputs: [a, b], output: path.join(root, 'm2') });
    expect(second.data.events.map((e) => e.event_id)).toEqual(first.data.events.map((e) => e.event_id));
    const third = await runMerge({ inputs: [path.join(root, 'm1'), b], output: path.join(root, 'm3') });
    expect(third.data.events).toHaveLength(first.data.events.length);
    expect(third.report.conflict_events).toBe(0);
  });

  it('rejects different projects', async () => {
    const root = await tempDir('aitimeline-merge-diffproj-');
    const a = await createInput(root, 'A', { projectId: 'proj_a', events: [ev('a1')] });
    const b = await createInput(root, 'B', { projectId: 'proj_b', events: [ev('b1')] });
    await expect(runMerge({ inputs: [a, b], output: path.join(root, 'merged') })).rejects.toThrow(/different project identities/);
  });

  it('requires explicit confirmation for weak name-derived identities', async () => {
    const root = await tempDir('aitimeline-merge-weak-');
    const a = await createInput(root, 'A', { deviceId: 'device-a', weak: true, events: [ev('a1')] });
    const b = await createInput(root, 'B', { deviceId: 'device-b', weak: true, events: [ev('b1')] });
    await expect(runMerge({ inputs: [a, b], output: path.join(root, 'm1') })).rejects.toThrow(/name-derived/);
    const ok = await runMerge({ inputs: [a, b], output: path.join(root, 'm2'), allowWeakIdentity: true });
    expect(ok.report.project_identity_status).toBe('weak_identity_confirmed');
  });

  it('preserves conflicting records as labelled variants instead of discarding them', async () => {
    const root = await tempDir('aitimeline-merge-conflict-');
    const a = await createInput(root, 'A', {
      deviceId: 'device-a',
      events: [ev('same-key', { content_hash: 'a'.repeat(64), activity: { content_summary: 'version A' } })],
    });
    const b = await createInput(root, 'B', {
      deviceId: 'device-b',
      events: [ev('same-key', { content_hash: 'b'.repeat(64), activity: { content_summary: 'version B' } })],
    });
    const result = await runMerge({ inputs: [a, b], output: path.join(root, 'merged') });
    expect(result.data.events).toHaveLength(2);
    expect(result.report.conflict_events).toBe(1);
    expect(result.data.conflicts).toHaveLength(1);
    const ids = result.data.events.map((e) => e.event_id);
    expect(ids).toContain(computeEventId('same-key'));
    expect(ids).toContain(computeConflictEventId('same-key', 'b'.repeat(64)));
    expect(result.data.events.every((e) => e.provenance.source_path_identity)).toBe(true);
    expect((await validatePackage(path.join(root, 'merged'))).ok).toBe(true);
  });

  it('preserves source provenance and scanner device identity', async () => {
    const root = await tempDir('aitimeline-merge-prov-');
    const a = await createInput(root, 'A', {
      deviceId: 'device-a',
      events: [ev('p1', { scanner_device_id: 'device-b', provenance: { ...makeEvent().provenance, source_path: 'device-a/session.jsonl' } })],
    });
    const b = await createInput(root, 'B', { deviceId: 'device-b', events: [ev('p2')] });
    const result = await runMerge({ inputs: [a, b], output: path.join(root, 'merged') });
    const p1 = result.data.events.find((e) => e.dedup_key === 'p1')!;
    expect(p1.device_id).toBe('device-a');
    expect(p1.scanner_device_id).toBe('device-b');
    expect(p1.provenance.source_path).toBe('device-a/session.jsonl');
  });

  it('reconstructs chronological order with deterministic tie-breakers', async () => {
    const root = await tempDir('aitimeline-merge-order-');
    const a = await createInput(root, 'A', {
      deviceId: 'device-a',
      events: [
        ev('late', { time: { occurred_at: '2026-11-17T03:00:00.000Z', observed_at: '2026-11-17T04:00:00.000Z' } }),
        ev('early', { time: { occurred_at: '2026-11-17T01:00:00.000Z', observed_at: '2026-11-17T04:00:00.000Z' } }),
      ],
    });
    const b = await createInput(root, 'B', { deviceId: 'device-b', events: [ev('mid', { time: { occurred_at: '2026-11-17T02:00:00.000Z', observed_at: '2026-11-17T04:00:00.000Z' } })] });
    const result = await runMerge({ inputs: [a, b], output: path.join(root, 'merged') });
    expect(result.data.events.map((e) => e.dedup_key)).toEqual(['early', 'mid', 'late']);
  });

  it('handles missing device metadata without fabricating a source device', async () => {
    const root = await tempDir('aitimeline-merge-nodev-');
    const a = await createInput(root, 'A', { deviceId: 'device-a', noDevices: true, events: [ev('a1')] });
    const b = await createInput(root, 'B', { deviceId: 'device-b', noDevices: true, events: [ev('b1')] });
    const result = await runMerge({ inputs: [a, b], output: path.join(root, 'merged') });
    expect(result.data.events).toHaveLength(2);
    expect(result.data.devices).toEqual([]);
    expect((result.report.warnings ?? []).some((w) => w.includes('No source device metadata'))).toBe(true);
  });

  it('rejects an input with an unsupported schema version', async () => {
    const root = await tempDir('aitimeline-merge-version-');
    const a = await createInput(root, 'A', { events: [ev('a1')], schemaVersion: '9.0.0' });
    const b = await createInput(root, 'B', { deviceId: 'device-b', events: [ev('b1')] });
    await expect(runMerge({ inputs: [a, b], output: path.join(root, 'merged') })).rejects.toThrow();
  });

  it('rejects an input whose checksums were tampered with', async () => {
    const root = await tempDir('aitimeline-merge-tamper-');
    const a = await createInput(root, 'A', { events: [ev('a1')] });
    const b = await createInput(root, 'B', { deviceId: 'device-b', events: [ev('b1')] });
    await writeFile(path.join(a, 'manifest.json'), '{"format":"broken"}\n');
    await expect(runMerge({ inputs: [a, b], output: path.join(root, 'merged') })).rejects.toThrow(/validation|checksum|parse/i);
  });

  it('embeds imported provenance and records content divergence instead of discarding it', () => {
    const base = makeEvent();
    const agent = {
      agent_id: 'cursor',
      agent_name: 'Cursor',
      native_session_id: 'sess-1',
      native_event_id: 'msg-1',
    };
    const native = ev('native-1', {
      agent,
      activity: { role: 'assistant', content: 'native text' },
      content_hash: 'a'.repeat(64),
      provenance: { ...base.provenance, capture_method: 'adapter:cursor', source_path: 'sessions/x.jsonl' },
    });
    const imported = ev('import-1', {
      agent,
      activity: { role: 'assistant', content: 'import text' },
      content_hash: 'b'.repeat(64),
      provenance: {
        ...base.provenance,
        capture_method: 'adapter:al-exporter',
        capture_level: 'derived',
        source_path: 'export/cursor/x.json',
        raw_payload_ref: 'archive/messages/1.json',
        source_record_id: 'import-1',
        import_identity_source: 'message_id',
      },
    });
    const result = deduplicateEvents([native, imported]);
    expect(result.deterministic_pairs).toBe(1);
    expect(result.events).toHaveLength(1);
    const kept = result.events[0]!;
    expect(kept.provenance.paired_import_sources?.[0]).toMatchObject({
      source_path: 'export/cursor/x.json',
      source_record_id: 'import-1',
      raw_payload_ref: 'archive/messages/1.json',
      capture_method: 'adapter:al-exporter',
      content_diverged: true,
    });
    expect(kept.provenance.paired_import_event_id).toBeUndefined();
    expect(kept.correlation?.note).toMatch(/divergence recorded/);
  });

  it('reconciles a device that is a scanner in one input and a source in another', async () => {
    const root = await tempDir('aitimeline-merge-device-role-');
    const aDir = path.join(root, 'A');
    const bDir = path.join(root, 'B');
    const a = buildInput({ deviceId: 'device-a', events: [ev('a1')] });
    a.devices = [
      { device_id: 'device-a', role: 'source' },
      { device_id: 'device-b', role: 'scanner' },
    ];
    a.manifest = { ...a.manifest, timeline_id: 'tln_a' };
    const b = buildInput({ deviceId: 'device-b', events: [ev('b1')] });
    b.manifest = { ...b.manifest, timeline_id: 'tln_b' };
    await writePackage(aDir, a);
    await writePackage(bDir, b);

    const result = await runMerge({ inputs: [aDir, bDir], output: path.join(root, 'merged') });
    expect(result.data.manifest.source_devices).toEqual(['device-a', 'device-b']);
    expect(result.report.source_devices).toBe(2);
    expect(result.data.devices.find((d) => d.device_id === 'device-b')?.role).toBe('both');
  });

  it('rejects a single input because merging requires two or more packages', async () => {
    const root = await tempDir('aitimeline-merge-single-');
    const a = await createInput(root, 'A', { events: [ev('a1')] });
    await expect(runMerge({ inputs: [a], output: path.join(root, 'merged') })).rejects.toThrow(
      /at least two/i,
    );
  });

  it('supports dry-run without writing any files', async () => {
    const root = await tempDir('aitimeline-merge-dry-');
    const a = await createInput(root, 'A', { events: [ev('a1')] });
    const b = await createInput(root, 'B', { deviceId: 'device-b', events: [ev('b1')] });
    const out = path.join(root, 'dry');
    const result = await runMerge({ inputs: [a, b], output: out, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.data.events).toHaveLength(2);
    await expect(validatePackage(out)).rejects.toThrow();
  });
});
