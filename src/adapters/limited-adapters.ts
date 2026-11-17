import { discoverSources, type DiscoverySpec } from './discovery.js';
import {
  makeCapabilities,
  type AdapterCapabilities,
  type AgentAdapter,
  type AgentSource,
  type DiscoverOptions,
  type ParseResult,
  type SessionReference,
} from './types.js';

/**
 * Discovery-only adapters for agents whose local session format could not be
 * verified in this environment. They intentionally return zero sessions rather
 * than inventing a parser or fabricating compatibility.
 */
class LimitedAdapter implements AgentAdapter {
  constructor(
    readonly id: string,
    readonly name: string,
    readonly version: string,
    private readonly spec: DiscoverySpec,
    private readonly capabilities: AdapterCapabilities,
  ) {}

  async discoverSources(options: DiscoverOptions = {}): Promise<AgentSource[]> {
    return discoverSources(this.spec, options);
  }

  async scanSessions(_source: AgentSource): Promise<SessionReference[]> {
    return [];
  }

  async parseSession(_session: SessionReference): Promise<ParseResult> {
    return {
      records: [],
      issues: [{ line: 0, reason: `no verified session parser for ${this.id}; source left unparsed` }],
      truncated: false,
    };
  }

  getCapabilities(): AdapterCapabilities {
    return this.capabilities;
  }
}

const CODEBUDDY: DiscoverySpec = {
  agentId: 'codebuddy',
  defaultDirs: ['~/.codebuddy', '~/Library/Application Support/CodeBuddy'],
  markers: ['logs', 'memery', 'settings.json', 'plugins'],
  childNames: ['.codebuddy', 'codebuddy'],
  format: 'unknown',
};

const ZCODE: DiscoverySpec = {
  agentId: 'zcode',
  defaultDirs: ['~/.zcode', '~/Library/Application Support/ZCode'],
  markers: ['sessions', 'conversations', 'projects'],
  childNames: ['.zcode', 'zcode'],
  format: 'unknown',
};

const OPENCODE: DiscoverySpec = {
  agentId: 'opencode',
  defaultDirs: ['~/.config/opencode', '~/.local/share/opencode', '~/.opencode'],
  markers: ['opencode.json', 'storage', 'project'],
  childNames: ['opencode', '.opencode'],
  format: 'unknown',
};

function limitedCapabilities(notes: string[], verification: AdapterCapabilities['verification']): AdapterCapabilities {
  return makeCapabilities({
    discovery: verification === 'discovery_only' ? 'verified' : 'partial',
    formats: [],
    verification,
    notes,
  });
}

export class CodeBuddyAdapter extends LimitedAdapter {
  constructor() {
    super('codebuddy', 'CodeBuddy', '0.1.0', CODEBUDDY, limitedCapabilities([
      'Real local directory observed: ~/.codebuddy contains logs/, memery/*.md, settings.json, plugins/.',
      'No session/conversation record format could be verified; scanSessions returns an empty list.',
      'Discovery only. No parsing capability is claimed.',
    ], 'discovery_only'));
  }
}

export class ZCodeAdapter extends LimitedAdapter {
  constructor() {
    super('zcode', 'ZCode', '0.1.0', ZCODE, limitedCapabilities([
      'No ~/.zcode directory exists on this machine; the data format is unknown.',
      'An explicit --source-root is accepted but yields no sessions until a real format is observed.',
      'Not implemented / not testable in the current environment.',
    ], 'not_testable'));
  }
}

export class OpenCodeAdapter extends LimitedAdapter {
  constructor() {
    super('opencode', 'OpenCode', '0.1.0', OPENCODE, limitedCapabilities([
      'Real local directory observed: ~/.config/opencode contains only opencode.json (configuration).',
      'No session data is present, so the parser is not implemented.',
      'Listed as an extension target; not a compatibility claim.',
    ], 'not_testable'));
  }
}
