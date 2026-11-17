import { CodexAdapter } from './codex.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { CursorAdapter } from './cursor.js';
import { QoderAdapter } from './qoder.js';
import { WorkBuddyAdapter } from './workbuddy.js';
import { TraeAdapter } from './trae.js';
import { CodeBuddyAdapter, ZCodeAdapter } from './limited-adapters.js';
import { OpenCodeAdapter } from './opencode.js';
import type { AgentAdapter } from './types.js';
import { UsageError } from '../core/errors.js';

/** Target list from the product specification, plus Qoder/OpenCode found locally. */
export function createAdapters(): AgentAdapter[] {
  return [
    new CodexAdapter(),
    new ClaudeCodeAdapter(),
    new CursorAdapter(),
    new ZCodeAdapter(),
    new QoderAdapter(),
    new TraeAdapter(),
    new CodeBuddyAdapter(),
    new WorkBuddyAdapter(),
    new OpenCodeAdapter(),
  ];
}

export function createRegistry(adapters: AgentAdapter[] = createAdapters()): Map<string, AgentAdapter> {
  return new Map(adapters.map((a) => [a.id, a]));
}

export function selectAdapters(ids: string[] | undefined, adapters: AgentAdapter[] = createAdapters()): AgentAdapter[] {
  if (!ids || ids.length === 0) return adapters;
  const registry = createRegistry(adapters);
  const selected: AgentAdapter[] = [];
  const unknown: string[] = [];
  for (const id of ids) {
    const adapter = registry.get(id.trim().toLowerCase());
    if (adapter) selected.push(adapter);
    else unknown.push(id);
  }
  if (unknown.length) {
    throw new UsageError(
      `Unknown agent id(s): ${unknown.join(', ')}. Known: ${[...registry.keys()].join(', ')}`,
    );
  }
  return selected;
}

export interface AdapterSummary {
  id: string;
  name: string;
  version: string;
  verification: string;
  formats: string[];
  capabilities: Record<string, string>;
  notes: string[];
}

export function summarizeAdapters(adapters: AgentAdapter[] = createAdapters()): AdapterSummary[] {
  return adapters.map((a) => {
    const c = a.getCapabilities();
    return {
      id: a.id,
      name: a.name,
      version: a.version,
      verification: c.verification,
      formats: c.formats,
      capabilities: {
        discovery: c.discovery,
        session_listing: c.session_listing,
        user_request: c.user_request,
        ai_request: c.ai_request,
        agent_response: c.agent_response,
        tool_calls: c.tool_calls,
        task_status: c.task_status,
        file_changes: c.file_changes,
        project_identity: c.project_identity,
        timestamps: c.timestamps,
        incremental_scan: c.incremental_scan,
        git_correlation: c.git_correlation,
      },
      notes: c.notes,
    };
  });
}
