import { describe, it, expect, beforeEach } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OpenCodeAdapter } from '../src/adapters/opencode.js';
import { tempDir } from './helpers/fixtures.js';

const CWD = '/tmp/fixture-project';

async function writeJson(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(value, null, 2));
}

async function makeStorage(): Promise<string> {
  const root = await tempDir('aitimeline-opencode-');
  await writeJson(path.join(root, 'project', 'global.json'), {
    id: 'global',
    worktree: CWD,
    vcs: 'git',
    time: { created: 1769498903348, updated: 1769498903450 },
  });
  await writeJson(path.join(root, 'session', 'global', 'ses_fixture_1.json'), {
    id: 'ses_fixture_1',
    slug: 'fixture-session',
    version: '1.1.36',
    projectID: 'global',
    directory: CWD,
    title: 'Fixture session',
    time: { created: 1769498903348, updated: 1769498907453 },
  });
  await writeJson(path.join(root, 'message', 'ses_fixture_1', 'msg_user.json'), {
    id: 'msg_user',
    sessionID: 'ses_fixture_1',
    role: 'user',
    time: { created: 1769498903398 },
    agent: 'plan',
    model: { providerID: 'fixture', modelID: 'fixture-model' },
  });
  await writeJson(path.join(root, 'part', 'msg_user', 'prt_text_1.json'), {
    id: 'prt_text_1',
    sessionID: 'ses_fixture_1',
    messageID: 'msg_user',
    type: 'text',
    text: 'Please add a timeline viewer',
  });
  await writeJson(path.join(root, 'message', 'ses_fixture_1', 'msg_assistant.json'), {
    id: 'msg_assistant',
    sessionID: 'ses_fixture_1',
    role: 'assistant',
    parentID: 'msg_user',
    time: { created: 1769498903407, completed: 1769498907453 },
    modelID: 'fixture-model',
    providerID: 'fixture',
    agent: 'build',
    mode: 'build',
    path: { cwd: CWD, root: '/' },
    tokens: { input: 12, output: 34 },
  });
  await writeJson(path.join(root, 'part', 'msg_assistant', 'prt_text_2.json'), {
    id: 'prt_text_2',
    sessionID: 'ses_fixture_1',
    messageID: 'msg_assistant',
    type: 'text',
    text: 'Viewer added',
  });
  return root;
}

async function sourceFor(root: string) {
  const sources = await new OpenCodeAdapter().discoverSources({ roots: [root] });
  return sources[0]!;
}

describe('OpenCode adapter (real local format, synthetic fixtures)', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeStorage();
  });

  it('discovers the storage root and lists sessions with project evidence', async () => {
    const adapter = new OpenCodeAdapter();
    const source = await sourceFor(root);
    expect(source.metadata?.matched_layout).toBe(true);
    const sessions = await adapter.scanSessions(source);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.native_session_id).toBe('ses_fixture_1');
    expect(sessions[0]!.project_evidence.cwd).toBe(CWD);
    expect(sessions[0]!.metadata?.skipped_symlinks).toBe(0);
  });

  it('parses user and assistant text with millisecond timestamps and model metadata', async () => {
    const adapter = new OpenCodeAdapter();
    const sessions = await adapter.scanSessions(await sourceFor(root));
    const result = await adapter.parseSession(sessions[0]!);
    expect(result.issues).toEqual([]);
    expect(result.records.map((r) => r.event_type)).toEqual([
      'agent.user_request.submitted',
      'agent.response.received',
    ]);
    expect(result.records[0]!.content).toBe('Please add a timeline viewer');
    expect(result.records[1]!.content).toBe('Viewer added');
    expect(result.records.every((r) => r.evidence_level === 'verified')).toBe(true);
    expect(result.records.every((r) => r.capture_level === 'observed')).toBe(true);
    expect(result.records[0]!.occurred_at).toBe('2026-01-27T07:28:23.398Z');
    expect(result.records[1]!.occurred_at).toBe('2026-01-27T07:28:27.453Z');
    expect(result.model).toBe('fixture-model');
    expect(result.project_evidence?.cwd).toBe(CWD);
    expect(result.native_project_id).toBe(CWD);
    expect(result.session_started_at).toBe('2026-01-27T07:28:23.348Z');
    expect(result.session_ended_at).toBe('2026-01-27T07:28:27.453Z');
  });

  it('exports a recorded API error as agent_reported failure, never as verified success', async () => {
    await writeJson(path.join(root, 'message', 'ses_fixture_1', 'msg_error.json'), {
      id: 'msg_error',
      sessionID: 'ses_fixture_1',
      role: 'assistant',
      time: { created: 1769498903408, completed: 1769498907400 },
      modelID: 'fixture-model',
      providerID: 'fixture',
      error: { name: 'APIError', data: { message: 'invalid api key', statusCode: 401 } },
    });
    const adapter = new OpenCodeAdapter();
    const sessions = await adapter.scanSessions(await sourceFor(root));
    const result = await adapter.parseSession(sessions[0]!);
    const failed = result.records.find((r) => r.source_record_id === 'msg_error')!;
    expect(failed.event_type).toBe('agent.response.received');
    expect(failed.execution_status).toBe('failed');
    expect(failed.error_message).toBe('invalid api key');
    expect(failed.evidence_level).toBe('agent_reported');
    expect(failed.capture_level).toBe('reported');
  });

  it('isolates malformed message files without discarding the session', async () => {
    await writeFile(path.join(root, 'message', 'ses_fixture_1', 'msg_broken.json'), '{"id":');
    const adapter = new OpenCodeAdapter();
    const sessions = await adapter.scanSessions(await sourceFor(root));
    const result = await adapter.parseSession(sessions[0]!);
    expect(result.issues.some((i) => i.reason.includes('msg_broken.json'))).toBe(true);
    expect(result.records).toHaveLength(2);
  });

  it('rejects an unsafe session id instead of reading outside the source root', async () => {
    await writeJson(path.join(root, 'session', 'global', 'ses_unsafe.json'), {
      id: '../../../etc',
      projectID: 'global',
      directory: CWD,
    });
    const adapter = new OpenCodeAdapter();
    const sessions = await adapter.scanSessions(await sourceFor(root));
    const unsafe = sessions.find((s) => s.relative_path.endsWith('ses_unsafe.json'))!;
    const result = await adapter.parseSession(unsafe);
    expect(result.records).toEqual([]);
    expect(result.issues[0]!.reason).toMatch(/unsafe/);
  });

  it('declares only observed capabilities', () => {
    const caps = new OpenCodeAdapter().getCapabilities();
    expect(caps.verification).toBe('partially_verified');
    expect(caps.user_request).toBe('verified');
    expect(caps.agent_response).toBe('verified');
    expect(caps.timestamps).toBe('verified');
    expect(caps.tool_calls).toBe('unavailable');
    expect(caps.file_changes).toBe('unavailable');
    expect(caps.notes.some((n) => n.includes('text'))).toBe(true);
  });
});
