import { describe, it, expect, beforeAll } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { CodexAdapter } from '../src/adapters/codex.js';
import { QoderAdapter } from '../src/adapters/qoder.js';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import { CursorAdapter } from '../src/adapters/cursor.js';
import { WorkBuddyAdapter } from '../src/adapters/workbuddy.js';
import { TraeAdapter } from '../src/adapters/trae.js';
import { CodeBuddyAdapter, ZCodeAdapter, OpenCodeAdapter } from '../src/adapters/limited-adapters.js';
import { summarizeAdapters } from '../src/adapters/registry.js';
import type { AgentSource, SessionReference } from '../src/adapters/types.js';
import {
  tempDir,
  writeCodexSession,
  writeQoderSession,
  writeCursorTranscript,
  writeWorkBuddyAudit,
  writeTraeMemory,
  writeJsonl,
} from './helpers/fixtures.js';

let root: string;
const CWD = '/tmp/fixture-project';

function sourceFor(agentId: string): AgentSource {
  return {
    source_id: `${agentId}-fixture`,
    agent_id: agentId,
    root,
    display_path: root,
    format: 'jsonl',
    discovered_from: 'fixture',
    readable: true,
    metadata: { matched_layout: true },
  };
}

function sessionFor(relative: string, agentId = 'codex'): SessionReference {
  return {
    native_session_id: 'fixture-session',
    source: sourceFor(agentId),
    path: path.join(root, relative),
    relative_path: relative,
    size_bytes: 0,
    project_evidence: {},
  };
}

beforeAll(async () => {
  root = await tempDir('aitimeline-adapters-');
  await mkdir(path.join(root, 'sessions/2026/01/01'), { recursive: true });
  await mkdir(path.join(root, 'projects/encoded'), { recursive: true });
  await mkdir(path.join(root, 'memory/projects/encoded/20261117'), { recursive: true });
  await mkdir(path.join(root, 'audit-log'), { recursive: true });
  await mkdir(path.join(root, 'agent-transcripts/u1'), { recursive: true });
});

describe('Codex adapter (real local format, synthetic fixtures)', () => {
  it('parses a valid session with user request, response, reported completion and cwd evidence', async () => {
    const relative = 'sessions/2026/01/01/rollout-valid.jsonl';
    await writeCodexSession(path.join(root, relative), { cwd: CWD, sessionId: 'cx-1', includeToolCall: true });
    const result = await new CodexAdapter().parseSession(sessionFor(relative));
    expect(result.issues).toEqual([]);
    expect(result.project_evidence?.cwd).toBe(CWD);
    expect(result.records.map((r) => r.event_type)).toEqual([
      'agent.session.started',
      'agent.user_request.submitted',
      'agent.response.received',
      'agent.tool.started',
      'agent.execution.completed',
    ]);
    expect(result.records.some((r) => r.event_type === 'agent.execution.completed' && r.evidence_level === 'agent_reported')).toBe(true);
    expect(result.records.some((r) => r.event_type === 'agent.tool.started')).toBe(true);
    expect(result.records.every((r) => r.source_record_id)).toBe(true);
  });

  it('isolates malformed and truncated records instead of dropping them silently', async () => {
    const relative = 'sessions/2026/01/01/rollout-bad.jsonl';
    await writeCodexSession(path.join(root, relative), { cwd: CWD, sessionId: 'cx-2', includeMalformed: true });
    const result = await new CodexAdapter().parseSession(sessionFor(relative));
    expect(result.issues.length).toBeGreaterThanOrEqual(1);
    expect(result.records.length).toBeGreaterThan(0);
  });

  it('handles a file without a trailing newline as possibly truncated', async () => {
    const relative = 'sessions/2026/01/01/rollout-truncated.jsonl';
    await writeFile(path.join(root, relative), JSON.stringify({ ordinal: 0, type: 'session_meta', payload: { cwd: CWD, id: 'cx-3' } }));
    const result = await new CodexAdapter().parseSession(sessionFor(relative));
    expect(result.issues.some((i) => i.reason.includes('newline'))).toBe(true);
  });

  it('decompresses zstd-archived rollouts in memory', async () => {
    const relative = 'sessions/2026/01/01/rollout-archived.jsonl.zst';
    const plain = [
      JSON.stringify({ ordinal: 0, timestamp: '2026-11-17T01:00:00.000Z', type: 'session_meta', payload: { id: 'cx-4', cwd: CWD } }),
      JSON.stringify({ ordinal: 1, timestamp: '2026-11-17T01:00:02.000Z', type: 'response_item', payload: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
    ].join('\n') + '\n';
    await writeFile(path.join(root, relative), zstdCompressSync(Buffer.from(plain)));
    const result = await new CodexAdapter().parseSession(sessionFor(relative));
    expect(result.records.length).toBe(2);
    expect(result.project_evidence?.cwd).toBe(CWD);
  });

  it('keeps duplicate native ids visible and ignores unsupported record types', async () => {
    const relative = 'sessions/2026/01/01/rollout-dupes.jsonl';
    await writeJsonl(path.join(root, relative), [
      { ordinal: 1, type: 'response_item', payload: { role: 'user', content: 'same question' } },
      { ordinal: 1, type: 'response_item', payload: { role: 'user', content: 'same question' } },
      { ordinal: 2, type: 'unknown_future_type', payload: { foo: 'bar' } },
    ]);
    const result = await new CodexAdapter().parseSession(sessionFor(relative));
    expect(result.records.filter((r) => r.event_type === 'agent.user_request.submitted')).toHaveLength(2);
    expect(result.records.some((r) => r.raw_type.includes('unknown_future_type'))).toBe(false);
  });

  it('does not fabricate project evidence when metadata is missing', async () => {
    const relative = 'sessions/2026/01/01/rollout-nometa.jsonl';
    await writeJsonl(path.join(root, relative), [
      { ordinal: 1, type: 'response_item', payload: { role: 'assistant', content: 'no cwd anywhere' } },
    ]);
    const result = await new CodexAdapter().parseSession(sessionFor(relative));
    expect(result.project_evidence?.cwd).toBeUndefined();
  });

  it('discovers multiple sessions through scanSessions', async () => {
    const sessions = await new CodexAdapter().scanSessions(sourceFor('codex'));
    expect(sessions.length).toBeGreaterThanOrEqual(5);
    expect(new Set(sessions.map((s) => s.native_session_id)).size).toBe(sessions.length);
  });
});

describe('Qoder adapter (real local format)', () => {
  it('parses user/assistant records with cwd, uuid and parent references', async () => {
    const relative = 'projects/encoded/qoder-1.jsonl';
    await writeQoderSession(path.join(root, relative), CWD);
    const result = await new QoderAdapter().parseSession(sessionFor(relative, 'qoder'));
    expect(result.project_evidence?.cwd).toBe(CWD);
    expect(result.records.some((r) => r.event_type === 'agent.user_request.submitted')).toBe(true);
    expect(result.records.some((r) => r.event_type === 'agent.response.received')).toBe(true);
    const assistant = result.records.find((r) => r.metadata?.parent_uuid === 'q-uuid-1');
    expect(assistant).toBeDefined();
    expect(result.records.every((r) => r.evidence_level === 'verified')).toBe(true);
  });

  it('parses tool_use blocks when present', async () => {
    const relative = 'projects/encoded/qoder-tools.jsonl';
    await writeJsonl(path.join(root, relative), [
      {
        type: 'assistant', sessionId: 'q1', uuid: 'u2', cwd: CWD, timestamp: '2026-11-17T02:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'write_file', input: { path: 'a.ts' } }] },
      },
    ]);
    const result = await new QoderAdapter().parseSession(sessionFor(relative, 'qoder'));
    expect(result.records.some((r) => r.event_type === 'agent.tool.started' && r.tool_name === 'write_file')).toBe(true);
  });
});

describe('Cursor adapter', () => {
  it('parses transcripts and preserves timestamp uncertainty', async () => {
    const relative = 'agent-transcripts/u1/u1.jsonl';
    await writeCursorTranscript(path.join(root, relative));
    const result = await new CursorAdapter().parseSession(sessionFor(relative, 'cursor'));
    expect(result.records.filter((r) => r.event_type.startsWith('agent.user_request') || r.event_type.startsWith('agent.response'))).toHaveLength(2);
    expect(result.records.every((r) => r.occurred_at === undefined)).toBe(true);
    expect(result.records.every((r) => r.timestamp_precision === 'unknown')).toBe(true);
  });

  it('reports unsupported record types', async () => {
    const relative = 'agent-transcripts/u1/u2.jsonl';
    await writeJsonl(path.join(root, relative), [{ role: 'system', type: 'future_type' }]);
    const result = await new CursorAdapter().parseSession(sessionFor(relative, 'cursor'));
    expect(result.issues.some((i) => i.reason.includes('unsupported'))).toBe(true);
  });

  it('returns no events for an unrecognized SQLite file', async () => {
    const relative = 'empty.db';
    await writeFile(path.join(root, relative), 'not a sqlite database');
    const result = await new CursorAdapter().parseSession(sessionFor(relative, 'cursor'));
    expect(result.records).toEqual([]);
    expect(result.truncated).toBe(true);
  });
});

describe('Claude Code adapter (format NOT locally verified)', () => {
  it('parses a synthetic JSONL fixture but reports not_testable', async () => {
    const relative = 'projects/encoded/claude-1.jsonl';
    await writeJsonl(path.join(root, relative), [
      { type: 'user', uuid: 'cc-1', cwd: CWD, timestamp: '2026-11-17T05:00:00.000Z', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', uuid: 'cc-2', cwd: CWD, timestamp: '2026-11-17T05:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
    ]);
    const adapter = new ClaudeCodeAdapter();
    const result = await adapter.parseSession(sessionFor(relative, 'claude-code'));
    expect(result.records).toHaveLength(2);
    expect(adapter.getCapabilities().verification).toBe('not_testable');
    expect(adapter.getCapabilities().verification).not.toBe('verified');
  });
});

describe('WorkBuddy / TRAE adapters (partial formats)', () => {
  it('produces audit events and marks inferred session starts', async () => {
    const relative = 'audit-log/2026-11-17.jsonl';
    await writeWorkBuddyAudit(path.join(root, relative));
    const result = await new WorkBuddyAdapter().parseSession(sessionFor(relative, 'workbuddy'));
    expect(result.records.some((r) => r.event_type === 'agent.audit.recorded' && r.evidence_level === 'verified')).toBe(true);
    expect(result.records.some((r) => r.event_type === 'agent.session.started' && r.evidence_level === 'inferred')).toBe(true);
    expect(result.records.some((r) => r.event_type === 'agent.user_request.submitted')).toBe(false);
  });

  it('marks memory summaries as agent_reported, never verified', async () => {
    const relative = 'memory/projects/encoded/20261117/session_memory_1.jsonl';
    await writeTraeMemory(path.join(root, relative));
    const result = await new TraeAdapter().parseSession(sessionFor(relative, 'trae'));
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.evidence_level).toBe('agent_reported');
  });
});

describe('Discovery-only adapters and honest capability declarations', () => {
  it('never fabricate sessions for unverified formats', async () => {
    for (const adapter of [new CodeBuddyAdapter(), new ZCodeAdapter(), new OpenCodeAdapter()]) {
      expect(await adapter.scanSessions(sourceFor(adapter.id))).toEqual([]);
      const parsed = await adapter.parseSession(sessionFor('none.jsonl', adapter.id));
      expect(parsed.records).toEqual([]);
      expect(parsed.issues.length).toBeGreaterThan(0);
    }
  });

  it('does not claim verified parsing for unverified agents', () => {
    const all = summarizeAdapters();
    const limited = all.filter((a) => ['codebuddy', 'zcode', 'opencode', 'claude-code'].includes(a.id));
    for (const a of limited) {
      expect(a.verification).not.toBe('verified');
      expect(a.capabilities.user_request).not.toBe('verified');
    }
    const codex = all.find((a) => a.id === 'codex')!;
    expect(codex.capabilities.ai_request).toBe('unavailable');
    expect(codex.notes.some((n) => n.includes('agent_reported'))).toBe(true);
  });
});
