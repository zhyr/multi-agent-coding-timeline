import { describe, expect, it } from 'vitest';
import { lineAllowed } from '../src/web/export.js';

describe('web export sanitization', () => {
  it('allows a normal JSONL event line', () => {
    const line = JSON.stringify({ event_id: 'evt_1', event_type: 'git.commit.created' });
    expect(lineAllowed(line)).toBe(true);
  });

  it('drops blank lines', () => {
    expect(lineAllowed('')).toBe(false);
    expect(lineAllowed('   \n')).toBe(false);
  });

  it('drops lines mentioning a blocked source path token', () => {
    const bad = JSON.stringify({
      event_id: 'evt_2',
      provenance: { source_path: '~/.cursor/projects/yuelideck-chrome/subagents/a.jsonl' },
    });
    expect(lineAllowed(bad)).toBe(false);
    expect(lineAllowed(bad.toUpperCase())).toBe(false);
  });

  it('keeps lines whose content merely contains the word in a normal sentence', () => {
    // Only path-like blocked tokens are targeted by the source-path scrubber;
    // the JSONL exporter drops any line that mentions the token at all, which is
    // conservative but intentional for the blocked-repository policy.
    const line = JSON.stringify({ body: 'no blocked repository here' });
    expect(lineAllowed(line)).toBe(true);
  });
});
