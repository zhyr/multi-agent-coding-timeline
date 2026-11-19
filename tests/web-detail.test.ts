import { describe, expect, it } from 'vitest';
import { buildViewerModel } from '../src/viewer/build.js';
import { buildDetailPage, eventTypes, agentOptions, sessionSegments, type DetailQuery } from '../src/web/detail.js';
import { makeEvent, makeTimelineData } from './helpers/fixtures.js';

function modelWithEvents(count: number) {
  const events = Array.from({ length: count }, (_, i) =>
    makeEvent({
      event_id: `evt_${String(i).padStart(4, '0')}`,
      dedup_key: `dedup_${i}`,
      event_type: i % 2 === 0 ? 'git.commit.created' : 'agent.response.received',
      occurred_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      activity: { role: i % 2 === 0 ? 'tool' : 'assistant', content: i % 5 === 0 ? 'FINDME needle' : 'ordinary body' },
    }),
  );
  return buildViewerModel(makeTimelineData({ events }));
}

const query = (over: Partial<DetailQuery> = {}): DetailQuery => ({
  q: '', type: '', evidence: '', agent: '', device: '', session: '', offset: 0, limit: 200, ...over,
});

describe('web detail pagination', () => {
  it('never returns more than the requested page (guards against UI freeze)', () => {
    const loaded = { model: modelWithEvents(500), signature: 'sig' };
    const page = buildDetailPage(loaded, query({ limit: 200 }));
    expect(page.events).toHaveLength(200);
    expect(page.total).toBe(500);
    expect(page.hasMore).toBe(true);
  });

  it('slices subsequent pages without overlap', () => {
    const loaded = { model: modelWithEvents(500), signature: 'sig' };
    const p1 = buildDetailPage(loaded, query({ offset: 0, limit: 200 }));
    const p2 = buildDetailPage(loaded, query({ offset: 200, limit: 200 }));
    const ids1 = new Set(p1.events.map((e) => e.id));
    expect(p2.events.every((e) => !ids1.has(e.id))).toBe(true);
    expect(p2.offset).toBe(200);
  });

  it('reports hasMore=false on the last page', () => {
    const loaded = { model: modelWithEvents(250), signature: 'sig' };
    const page = buildDetailPage(loaded, query({ offset: 200, limit: 200 }));
    expect(page.events).toHaveLength(50);
    expect(page.hasMore).toBe(false);
  });

  it('filters by type and by text on the server side', () => {
    const loaded = { model: modelWithEvents(100), signature: 'sig' };
    const byType = buildDetailPage(loaded, query({ type: 'git.commit.created' }));
    expect(byType.total).toBe(50);
    expect(byType.events.every((e) => e.type === 'git.commit.created')).toBe(true);
    const byText = buildDetailPage(loaded, query({ q: 'needle' }));
    expect(byText.total).toBe(20);
  });

  it('exposes distinct event types for the filter dropdown', () => {
    const loaded = { model: modelWithEvents(20), signature: 'sig' };
    expect(eventTypes(loaded)).toEqual(['agent.response.received', 'git.commit.created']);
  });

  it('filters by code agent id/name and lists agent options', () => {
    const loaded = { model: modelWithEvents(20), signature: 'sig' };
    const opts = agentOptions(loaded);
    expect(opts.length).toBeGreaterThan(0);
    const byAgent = buildDetailPage(loaded, query({ agent: opts[0].id }));
    expect(byAgent.total).toBeGreaterThan(0);
    expect(byAgent.events.every((e) => e.agentId === opts[0].id || e.agentName === opts[0].id)).toBe(true);
  });

  it('clamps an oversized limit to a safe maximum', () => {
    const loaded = { model: modelWithEvents(1000), signature: 'sig' };
    const page = buildDetailPage(loaded, query({ limit: 100000 }));
    expect(page.events.length).toBeLessThanOrEqual(500);
  });
});

/** Events spanning two sessions, two devices and two agents. */
function multiDimModel() {
  const codex = { agent_id: 'codex', agent_name: 'OpenAI Codex', adapter_version: '1.0.0' };
  const cursor = { agent_id: 'cursor', agent_name: 'Cursor', adapter_version: '1.0.0' };
  const at = (t: string) => ({ occurred_at: t, observed_at: t });
  const events = [
    makeEvent({ event_id: 'a1', dedup_key: 'a1', time: at('2026-11-17T00:00:00.000Z'), session_id: 'sess_A', device_id: 'device-1', agent: { ...codex } }),
    makeEvent({ event_id: 'a2', dedup_key: 'a2', time: at('2026-11-17T00:01:00.000Z'), session_id: 'sess_A', device_id: 'device-1', agent: { ...codex } }),
    makeEvent({ event_id: 'b1', dedup_key: 'b1', time: at('2026-11-17T00:02:00.000Z'), session_id: 'sess_B', device_id: 'device-1', agent: { ...codex } }),
    makeEvent({ event_id: 'c1', dedup_key: 'c1', time: at('2026-11-17T00:03:00.000Z'), session_id: 'sess_A', device_id: 'device-2', agent: { ...cursor } }),
  ];
  return buildViewerModel(makeTimelineData({ events }));
}

describe('web detail device/session filters', () => {
  it('filters by device and by session', () => {
    const loaded = { model: multiDimModel(), signature: 'sig' };
    const byDevice = buildDetailPage(loaded, query({ device: 'device-1' }));
    expect(byDevice.total).toBe(3);
    const bySession = buildDetailPage(loaded, query({ session: 'sess_A' }));
    expect(bySession.total).toBe(3);
    const both = buildDetailPage(loaded, query({ device: 'device-1', session: 'sess_A' }));
    expect(both.total).toBe(2);
  });
});

describe('web detail conversation segments', () => {
  it('groups events by (session, device, agent) and orders by last activity', () => {
    const loaded = { model: multiDimModel(), signature: 'sig' };
    const page = sessionSegments(loaded, query());
    expect(page.total).toBe(3); // sess_A/device-1/codex, sess_B/device-1/codex, sess_A/device-2/cursor
    const a1 = page.segments.find((s) => s.sessionId === 'sess_A' && s.deviceId === 'device-1');
    expect(a1?.eventCount).toBe(2);
    expect(a1?.agentId).toBe('codex');
    expect(a1?.firstAt).toBe('2026-11-17T00:00:00.000Z');
    expect(a1?.lastAt).toBe('2026-11-17T00:01:00.000Z');
    // Most recent segment first.
    expect(page.segments[0]?.sessionId + ':' + page.segments[0]?.deviceId).toBe('sess_A:device-2');
  });

  it('filters segments by agent, device and session independently', () => {
    const loaded = { model: multiDimModel(), signature: 'sig' };
    expect(sessionSegments(loaded, query({ agent: 'cursor' })).total).toBe(1);
    expect(sessionSegments(loaded, query({ device: 'device-1' })).total).toBe(2);
    expect(sessionSegments(loaded, query({ session: 'sess_A' })).total).toBe(2);
  });

  it('pages segments without overlap', () => {
    const loaded = { model: multiDimModel(), signature: 'sig' };
    const p1 = sessionSegments(loaded, query({ limit: 2 }));
    const p2 = sessionSegments(loaded, query({ limit: 2, offset: 2 }));
    expect(p1.segments).toHaveLength(2);
    expect(p2.segments).toHaveLength(1);
    expect(p2.hasMore).toBe(false);
  });
});
