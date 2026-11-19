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

  it('falls back to content_summary for body when only a summary was retained', () => {
    const event = makeEvent({
      event_id: 'evt_summary',
      dedup_key: 'dedup_summary',
      activity: { role: 'user', content_summary: 'summary only body', tool_name: 'Read' },
    });
    const model = buildViewerModel(makeTimelineData({ events: [event] }));
    expect(model.events[0]?.body).toBe('summary only body');
  });

  it('projects tool calls, execution state and context refs into the viewer model', () => {
    const event = makeEvent({
      event_id: 'evt_tool',
      dedup_key: 'dedup_tool',
      activity: {
        role: 'assistant',
        tool_name: 'Grep',
        execution_status: 'error',
        error_message: 'aborted',
        context_refs: ['src/index.ts', 'docs/readme.md'],
      },
    });
    const model = buildViewerModel(makeTimelineData({ events: [event] }));
    expect(model.events[0]?.toolName).toBe('Grep');
    expect(model.events[0]?.executionStatus).toBe('error');
    expect(model.events[0]?.errorMessage).toBe('aborted');
    expect(model.events[0]?.contextRefs).toEqual(['src/index.ts', 'docs/readme.md']);
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

  it('keeps all events in the embedded model but paginates the rendered list', () => {
    const events = Array.from({ length: 1_000 }, (_, i) =>
      makeEvent({
        event_id: `evt_${String(i).padStart(4, '0')}`,
        dedup_key: `dedup_${i}`,
        time: {
          occurred_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + i * 1000).toISOString(),
          observed_at: '2026-11-17T00:00:00.000Z',
        },
      }),
    );
    const model = buildViewerModel(makeTimelineData({ events }));
    expect(model.events).toHaveLength(1_000);
    const html = renderTimelineHtml(makeTimelineData({ events }));
    expect(html).toContain('evt_0999');
    expect(html).toContain('var PAGE=300');
    expect(html).toContain('Show more (');
  });

  it('contains no network APIs or external resource references', () => {
    const html = renderTimelineHtml(sampleData());
    expect(html).not.toMatch(/\bfetch\s*\(/);
    expect(html).not.toMatch(/XMLHttpRequest|WebSocket|EventSource/);
    expect(html).not.toMatch(/(src|href)="https?:\/\//);
    expect(html).toContain("default-src 'none'");
  });

  it('escapes an injected document title', () => {
    const html = renderTimelineHtml(sampleData(), { title: '</title><script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;/title&gt;');
  });
});

describe('viewer sender attribution', () => {
  const agent = {
    agent_id: 'codex',
    agent_name: 'OpenAI Codex',
    adapter_version: '1.0.0',
    verification: 'verified' as const,
    capabilities: {},
  };

  function modelOf(event: ReturnType<typeof makeEvent>) {
    return buildViewerModel(makeTimelineData({ events: [event], agents: [agent] }));
  }

  it('labels a user-role event as 用户', () => {
    const m = modelOf(makeEvent({ activity: { role: 'user', content_summary: 'hi' }, agent: { ...agent } }));
    expect(m.events[0].sender.kind).toBe('user');
    expect(m.events[0].sender.label).toBe('用户');
  });

  it('labels a normal assistant event as the agent', () => {
    const m = modelOf(makeEvent({
      event_type: 'agent.response.received',
      activity: { role: 'assistant', content_summary: 'ok' },
      agent: { ...agent },
    }));
    expect(m.events[0].sender.kind).toBe('agent');
    expect(m.events[0].sender.agentName).toBe('OpenAI Codex');
  });

  it('labels a /subagents/ source as 子代理 with a readable name', () => {
    const m = modelOf(makeEvent({
      event_type: 'agent.response.received',
      activity: { role: 'assistant', content_summary: 'sub' },
      agent: { ...agent, native_session_id: 'agent-a【示例】研究助手-462a2edd90c83e7f' },
      provenance: {
        source_type: 'agent-session',
        source_path: '~/.cursor/projects/forge/abc/subagents/agent-a【示例】研究助手-462a2edd90c83e7f.jsonl',
        source_path_identity: 'cursor/sub.jsonl',
        capture_method: 'adapter:cursor',
        capture_level: 'observed',
      },
    }));
    expect(m.events[0].sender.kind).toBe('subagent');
    expect(m.events[0].sender.label).toBe('子代理');
    expect(m.events[0].sender.detail).toContain('研究助手');
  });

  it('labels a git event as Git source', () => {
    const m = modelOf(makeEvent({
      event_type: 'git.commit.created',
      git: { commit_sha: 'a'.repeat(40) },
      // no agent, no activity role
      agent: undefined,
      activity: undefined,
    }));
    expect(m.events[0].sender.kind).toBe('source');
    expect(m.events[0].sender.label).toBe('Git');
  });
});
