import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { runMerge } from '../src/merge/engine.js';
import { writePackage, validatePackage } from '../src/package/index.js';
import type { TimelineData } from '../src/package/model.js';
import type { ActivityEvent } from '../src/schema/entities.js';
import { makeTimelineData, makeEvent, tempDir } from './helpers/fixtures.js';

const T0 = '2026-11-17T03:00:00.000Z';

function nativeEvent(
  deviceId: string,
  options: {
    nativeSessionId?: string;
    nativeEventId?: string;
    content?: string;
    occurredAt?: string;
    scannerDeviceId?: string;
    dedupKey?: string;
    eventType?: string;
  } = {},
): ActivityEvent {
  const nativeSessionId = options.nativeSessionId ?? 'native-session-1';
  const nativeEventId = options.nativeEventId ?? 'native-event-1';
  const content = options.content ?? 'shared cross-device message';
  const dedupKey =
    options.dedupKey ??
    `dedup:native\u0000codex\u0000${nativeSessionId}\u0000${nativeEventId}`;
  return makeEvent({
    dedup_key: dedupKey,
    dedup_tier: 'native_id',
    device_id: deviceId,
    scanner_device_id: options.scannerDeviceId ?? deviceId,
    event_type: options.eventType ?? 'agent.user_request.submitted',
    agent: {
      agent_id: 'codex',
      agent_name: 'Codex',
      native_session_id: nativeSessionId,
      native_event_id: nativeEventId,
    },
    activity: { role: 'user', content },
    time: { occurred_at: options.occurredAt ?? T0, observed_at: T0, timestamp_precision: 'second' },
    provenance: {
      ...makeEvent().provenance,
      source_path: `~/.codex/sessions/${deviceId}/rollout.jsonl`,
      source_path_identity: 'codex/sessions/rollout.jsonl',
      source_record_id: nativeEventId,
    },
  });
}

function gitEvent(deviceId: string, content = 'shared commit', sha = 'a'.repeat(40)): ActivityEvent {
  return makeEvent({
    dedup_key: `dedup:source\u0000${deviceId}\u0000git/${sha}`,
    dedup_tier: 'source_location',
    device_id: deviceId,
    scanner_device_id: deviceId,
    event_type: 'git.commit.created',
    activity: { content },
    git: { commit_sha: sha },
    time: { occurred_at: T0, observed_at: T0, timestamp_precision: 'second' },
    provenance: {
      ...makeEvent().provenance,
      source_type: 'git-repository',
      source_path: 'git:HEAD',
      source_path_identity: 'git/refs/commits',
      source_record_id: sha,
    },
  });
}

interface InputSpec {
  deviceId: string;
  events: ActivityEvent[];
}

function buildInput(spec: InputSpec): TimelineData {
  const base = makeTimelineData();
  const projectId = 'proj_cross_device';
  return makeTimelineData({
    manifest: {
      ...base.manifest,
      timeline_id: `tln_${spec.deviceId}`,
      project_id: projectId,
      source_devices: [spec.deviceId],
    },
    project: {
      ...base.project,
      project_id: projectId,
      canonical_remote_url: 'https://github.com/example/cross-device',
      identity_basis: 'remote',
      identity_strong: true,
    },
    devices: [{ device_id: spec.deviceId, role: 'source', scanner_device_id: spec.deviceId }],
    events: spec.events.map((event) => ({ ...event, project_id: projectId })),
  });
}

async function createInput(root: string, name: string, spec: InputSpec): Promise<string> {
  const dir = path.join(root, name);
  await writePackage(dir, buildInput(spec));
  return dir;
}

describe('cross-device correlation and deduplication', () => {
  it('folds an identical native event from two devices into one event with both observations', async () => {
    const root = await tempDir('aitimeline-cross-native-');
    const a = await createInput(root, 'A', { deviceId: 'device-a', events: [nativeEvent('device-a')] });
    const b = await createInput(root, 'B', { deviceId: 'device-b', events: [nativeEvent('device-b')] });
    const result = await runMerge({ inputs: [a, b], output: path.join(root, 'merged') });

    expect(result.data.events).toHaveLength(1);
    const event = result.data.events[0]!;
    expect(event.correlation_id).toBeTruthy();
    expect(event.provenance.observers?.map((o) => o.device_id).sort()).toEqual(['device-a', 'device-b']);
    expect(event.provenance.observers?.every((o) => o.relation === 'same_native_id')).toBe(true);
    expect(result.report.cross_device_deterministic).toBe(1);
    expect(result.report.cross_device_merged).toBe(1);
    expect((await validatePackage(path.join(root, 'merged'))).ok).toBe(true);
  });

  it('keeps source_device_id and scanner_device_id independent for a remote observation', async () => {
    const root = await tempDir('aitimeline-cross-scanner-');
    const local = await createInput(root, 'A-local', {
      deviceId: 'device-a',
      events: [nativeEvent('device-a', { scannerDeviceId: 'device-a' })],
    });
    // The same source device A, but this package was produced by scanner B.
    const remote = await createInput(root, 'A-remote', {
      deviceId: 'device-a',
      events: [nativeEvent('device-a', { scannerDeviceId: 'device-b' })],
    });
    const result = await runMerge({ inputs: [local, remote], output: path.join(root, 'merged') });
    expect(result.data.events).toHaveLength(1);
    const event = result.data.events[0]!;
    expect(event.device_id).toBe('device-a');
    expect(event.provenance.observers?.map((o) => o.scanner_device_id).sort()).toEqual(['device-a', 'device-b']);
    expect(result.report.cross_device_deterministic).toBe(1);
  });

  it('preserves both conflicting versions when the same native id has different content', async () => {
    const root = await tempDir('aitimeline-cross-conflict-');
    const a = await createInput(root, 'A', { deviceId: 'device-a', events: [nativeEvent('device-a', { content: 'version A' })] });
    const b = await createInput(root, 'B', { deviceId: 'device-b', events: [nativeEvent('device-b', { content: 'version B' })] });
    const result = await runMerge({ inputs: [a, b], output: path.join(root, 'merged') });

    expect(result.data.events).toHaveLength(2);
    const ids = new Set(result.data.events.map((e) => e.correlation_id));
    expect(ids.size).toBe(1);
    expect(result.report.cross_device_conflicts).toBe(1);
    expect(result.report.conflict_events).toBe(1);
    expect(result.data.events.map((e) => e.activity?.content).sort()).toEqual(['version A', 'version B']);
    expect(new Set(result.data.events.map((e) => e.event_id)).size).toBe(2);
  });

  it('correlates independent same-content events as an inferred candidate and keeps both', async () => {
    const root = await tempDir('aitimeline-cross-content-');
    const a = await createInput(root, 'A', {
      deviceId: 'device-a',
      events: [nativeEvent('device-a', { nativeSessionId: 'session-a', nativeEventId: 'evt-a', content: 'identical text' })],
    });
    const b = await createInput(root, 'B', {
      deviceId: 'device-b',
      events: [nativeEvent('device-b', { nativeSessionId: 'session-b', nativeEventId: 'evt-b', content: 'identical text' })],
    });
    const result = await runMerge({ inputs: [a, b], output: path.join(root, 'merged') });

    expect(result.data.events).toHaveLength(2);
    const ids = new Set(result.data.events.map((e) => e.correlation_id));
    expect(ids.size).toBe(1);
    for (const event of result.data.events) {
      expect(event.correlation?.kind).toBe('time_based_inference');
      expect(event.correlation?.match_confidence).toBe('candidate');
      expect(event.correlation?.note).toMatch(/not merged/);
    }
    expect(result.report.cross_device_candidates).toBe(1);
    expect(result.report.cross_device_merged).toBe(0);
  });

  it('does not correlate identical text at different times', async () => {
    const root = await tempDir('aitimeline-cross-time-');
    const a = await createInput(root, 'A', {
      deviceId: 'device-a',
      events: [nativeEvent('device-a', { nativeSessionId: 'session-a', nativeEventId: 'evt-a', occurredAt: T0 })],
    });
    const b = await createInput(root, 'B', {
      deviceId: 'device-b',
      events: [nativeEvent('device-b', { nativeSessionId: 'session-b', nativeEventId: 'evt-b', occurredAt: '2026-11-17T04:00:00.000Z' })],
    });
    const result = await runMerge({ inputs: [a, b], output: path.join(root, 'merged') });
    expect(result.data.events).toHaveLength(2);
    expect(result.data.events.every((e) => !e.correlation_id)).toBe(true);
    expect(result.report.cross_device_candidates).toBe(0);
  });

  it('does not correlate identical text within one device', async () => {
    const root = await tempDir('aitimeline-cross-same-device-');
    const a = await createInput(root, 'A', {
      deviceId: 'device-a',
      events: [
        nativeEvent('device-a', { nativeSessionId: 'session-a1', nativeEventId: 'evt-a1' }),
        nativeEvent('device-a', { nativeSessionId: 'session-a2', nativeEventId: 'evt-a2' }),
      ],
    });
    const b = await createInput(root, 'B', {
      deviceId: 'device-b',
      events: [nativeEvent('device-b', { nativeSessionId: 'session-b', nativeEventId: 'evt-b', content: 'unrelated' })],
    });
    const result = await runMerge({ inputs: [a, b], output: path.join(root, 'merged') });
    expect(result.data.events).toHaveLength(3);
    expect(result.data.events.every((e) => !e.correlation_id)).toBe(true);
    expect(result.report.cross_device_candidates).toBe(0);
  });

  it('folds the same git commit object observed on two devices', async () => {
    const root = await tempDir('aitimeline-cross-git-');
    const a = await createInput(root, 'A', { deviceId: 'device-a', events: [gitEvent('device-a')] });
    const b = await createInput(root, 'B', { deviceId: 'device-b', events: [gitEvent('device-b')] });
    const result = await runMerge({ inputs: [a, b], output: path.join(root, 'merged') });

    expect(result.data.events).toHaveLength(1);
    const event = result.data.events[0]!;
    expect(event.event_type).toBe('git.commit.created');
    expect(event.correlation_id).toBeTruthy();
    expect(event.provenance.observers?.map((o) => o.device_id).sort()).toEqual(['device-a', 'device-b']);
    expect(event.provenance.observers?.every((o) => o.relation === 'git_object')).toBe(true);
    expect(result.report.cross_device_deterministic).toBe(1);
  });

  it('keeps a git commit content conflict visible', async () => {
    const root = await tempDir('aitimeline-cross-git-conflict-');
    const a = await createInput(root, 'A', { deviceId: 'device-a', events: [gitEvent('device-a', 'message A')] });
    const b = await createInput(root, 'B', { deviceId: 'device-b', events: [gitEvent('device-b', 'message B')] });
    const result = await runMerge({ inputs: [a, b], output: path.join(root, 'merged') });
    expect(result.data.events).toHaveLength(2);
    expect(result.report.cross_device_conflicts).toBe(1);
    expect(result.data.events.map((e) => e.activity?.content).sort()).toEqual(['message A', 'message B']);
  });

  it('is idempotent: observers and correlation ids do not multiply on re-merge', async () => {
    const root = await tempDir('aitimeline-cross-idem-');
    const a = await createInput(root, 'A', { deviceId: 'device-a', events: [nativeEvent('device-a')] });
    const b = await createInput(root, 'B', { deviceId: 'device-b', events: [nativeEvent('device-b')] });
    const first = await runMerge({ inputs: [a, b], output: path.join(root, 'm1') });
    const second = await runMerge({ inputs: [path.join(root, 'm1'), b], output: path.join(root, 'm2') });
    expect(second.data.events.map((e) => e.event_id)).toEqual(first.data.events.map((e) => e.event_id));
    expect(second.data.events[0]?.correlation_id).toBe(first.data.events[0]?.correlation_id);
    expect(second.data.events[0]?.provenance.observers).toHaveLength(2);
    expect(second.data.events).toHaveLength(1);
  });

  it('records all observations when three devices share one native identity', async () => {
    const root = await tempDir('aitimeline-cross-three-');
    const a = await createInput(root, 'A', { deviceId: 'device-a', events: [nativeEvent('device-a')] });
    const b = await createInput(root, 'B', { deviceId: 'device-b', events: [nativeEvent('device-b')] });
    const c = await createInput(root, 'C', { deviceId: 'device-c', events: [nativeEvent('device-c')] });
    const result = await runMerge({ inputs: [a, b, c], output: path.join(root, 'merged') });
    expect(result.data.events).toHaveLength(1);
    expect(result.data.events[0]?.provenance.observers?.map((o) => o.device_id).sort()).toEqual([
      'device-a',
      'device-b',
      'device-c',
    ]);
    expect(result.report.cross_device_deterministic).toBe(1);
    expect(result.report.cross_device_merged).toBe(1);
  });
});
