import { describe, expect, it } from 'vitest';
import { buildViewerModel, renderTimelineHtml } from '../src/viewer/build.js';
import { makeEvent, makeTimelineData } from './helpers/fixtures.js';

function sampleData() {
  const event = makeEvent({
    event_id: 'evt_1',
    dedup_key: 'dedup_1',
    activity: {
      role: 'user',
      content: 'Please <script>alert("xss")</script> implement it',
      content_summary: 'Please <script>alert("xss")</script> implement it',
    },
    git: { commit_sha: 'a'.repeat(40), branch: 'main', changed_files: ['src/a.ts'] },
  });
  return makeTimelineData({
    events: [event],
    agents: [
      {
        agent_id: 'codex',
        agent_name: 'Codex',
        adapter_version: '1.0.0',
        verification: 'verified',
        capabilities: { sessions: 'verified' },
      },
    ],
    sessions: [
      {
        session_id: 'ses_1',
        project_id: 'proj_fixture',
        device_id: 'device-fixture',
        agent_id: 'codex',
        native_session_id: 'native-1',
        source_path: '/tmp/session.jsonl',
        source_path_identity: 'codex/session.jsonl',
        event_count: 1,
        match_confidence: 'exact',
        match_basis: 'cwd',
      },
    ],
    sources: [
      {
        source_id: 'src_1',
        agent_id: 'codex',
        device_id: 'device-fixture',
        source_path: '/tmp/session.jsonl',
        source_path_identity: 'codex/session.jsonl',
        source_type: 'session',
        status: 'scanned',
        record_count: 4,
      },
    ],
    commits: [
      {
        commit_sha: 'a'.repeat(40),
        parent_shas: [],
        project_id: 'proj_fixture',
        device_id: 'device-fixture',
        branch: 'main',
        message: 'fixture commit',
        committed_at: '2026-11-17T00:00:02.000Z',
        files_changed: 1,
        insertions: 2,
        deletions: 0,
        changed_files: ['src/a.ts'],
        evidence_level: 'verified',
      },
    ],
  });
}

describe('viewer', () => {
  it('renders a self-contained offline HTML document with provenance', () => {
    const html = renderTimelineHtml(sampleData(), { generatedAt: '2026-11-17T05:00:00.000Z' });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('fixture-project');
    expect(html).toContain('evt_1');
    expect(html).toContain('codex/session.jsonl');
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('2026-11-17T05:00:00.000Z');
    expect(html).not.toMatch(/(src|href)="https?:\/\//);
  });

  it('escapes content so it cannot become executable markup', () => {
    const html = renderTimelineHtml(sampleData());
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain('\\u003cscript\\u003ealert(\\"xss\\")\\u003c/script\\u003e');
  });

  it('never embeds content fields in metadata_only packages', () => {
    const data = sampleData();
    data.manifest.content_mode = 'metadata_only';
    const html = renderTimelineHtml(data);
    expect(html).not.toContain('alert("xss")');
    expect(html).not.toContain('Please');
  });

  it('sorts events by occurred time with session order as a tiebreaker', () => {
    const early = makeEvent({
      event_id: 'evt_early',
      dedup_key: 'dedup_early',
      time: { occurred_at: '2026-11-16T23:00:00.000Z', observed_at: '2026-11-17T00:00:00.000Z' },
      sequence_hint: 2,
    });
    const late = makeEvent({
      event_id: 'evt_late',
      dedup_key: 'dedup_late',
      time: { occurred_at: '2026-11-17T01:00:00.000Z', observed_at: '2026-11-17T01:00:01.000Z' },
      sequence_hint: 1,
    });
    const model = buildViewerModel(makeTimelineData({ events: [late, early] }));
    expect(model.events.map((e) => e.id)).toEqual(['evt_early', 'evt_late']);
  });

  it('keeps evidence level and confidence verbatim', () => {
    const event = makeEvent({
      event_id: 'evt_inferred',
      dedup_key: 'dedup_inferred',
      evidence: { level: 'inferred', basis: 'time proximity', note: 'not proof' },
      correlation: { kind: 'likely_related', match_confidence: 'candidate' },
      provenance: {
        source_type: 'agent-session',
        source_path: '/tmp/x.jsonl',
        source_path_identity: 'codex/x.jsonl',
        capture_method: 'adapter:codex',
        capture_level: 'observed',
        confidence: 0.6,
      },
    });
    const [rendered] = buildViewerModel(makeTimelineData({ events: [event] })).events;
    expect(rendered?.evidence).toBe('inferred');
    expect(rendered?.confidence).toBe(0.6);
    expect(rendered?.matchConfidence).toBe('candidate');
  });
});
