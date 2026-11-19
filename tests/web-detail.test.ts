import { describe, expect, it } from 'vitest';
import { buildViewerModel } from '../src/viewer/build.js';
import { buildDetailPage, eventTypes, agentOptions, type DetailQuery } from '../src/web/detail.js';
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
  q: '', type: '', evidence: '', agent: '', offset: 0, limit: 200, ...over,
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
