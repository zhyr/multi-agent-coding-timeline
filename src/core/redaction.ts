import type { ContentMode } from './constants.js';

interface SecretRule {
  kind: string;
  pattern: RegExp;
  replacement: string | ((match: string, ...groups: string[]) => string);
}

/**
 * Best-effort secret redaction. Deliberately conservative: only well-known
 * credential shapes are matched so ordinary source code is not mangled.
 * Redaction is never presented as a guarantee of complete sanitization.
 */
const RULES: SecretRule[] = [
  {
    kind: 'private_key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED:private_key]',
  },
  {
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: '[REDACTED:jwt]',
  },
  {
    kind: 'openai_key',
    pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    replacement: '[REDACTED:api_key]',
  },
  {
    kind: 'github_token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    replacement: '[REDACTED:github_token]',
  },
  {
    kind: 'slack_token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: '[REDACTED:slack_token]',
  },
  {
    kind: 'aws_key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: '[REDACTED:aws_access_key]',
  },
  {
    kind: 'google_key',
    pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g,
    replacement: '[REDACTED:google_api_key]',
  },
  {
    kind: 'bearer_token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    replacement: 'Bearer [REDACTED:token]',
  },
  {
    kind: 'credential_assignment',
    pattern: /((?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|token|authorization)\s*[:=]\s*)(["']?)([^\s"',;}{]{6,})\2/gi,
    replacement: (_m, prefix: string, quote: string) => `${prefix}${quote}[REDACTED:credential]${quote}`,
  },
  {
    kind: 'connection_string',
    pattern: /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|mssql):\/\/)([^:\s/@]+):([^@\s/]+)@/gi,
    replacement: (_m, scheme: string, user: string) => `${scheme}${user}:[REDACTED:password]@`,
  },
];

export interface RedactionResult {
  text: string;
  kinds: string[];
}

export function redactSecrets(input: string): RedactionResult {
  let text = input;
  const kinds = new Set<string>();
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    const probe = new RegExp(rule.pattern.source, rule.pattern.flags);
    if (probe.test(text)) kinds.add(rule.kind);
    rule.pattern.lastIndex = 0;
    text = text.replace(rule.pattern, rule.replacement as never);
  }
  return { text, kinds: [...kinds] };
}

export function detectSecrets(input: string): string[] {
  const kinds = new Set<string>();
  for (const rule of RULES) {
    const probe = new RegExp(rule.pattern.source, rule.pattern.flags);
    if (probe.test(input)) kinds.add(rule.kind);
  }
  return [...kinds];
}

function truncate(input: string, limit: number): string {
  if (input.length <= limit) return input;
  return `${input.slice(0, limit)}… [truncated ${input.length - limit} chars]`;
}

export interface ContentFields {
  content?: string;
  content_summary?: string;
  content_length: number;
  redaction_kinds: string[];
}

/**
 * Content minimization policy:
 *  - metadata_only: no text at all, just length + (external) hash.
 *  - summary:       redacted, bounded excerpt. Default.
 *  - full:          redacted full text. Requires an explicit CLI flag.
 */
export function applyContentMode(raw: string | undefined, mode: ContentMode): ContentFields {
  if (raw === undefined || raw === '') {
    return { content_length: 0, redaction_kinds: [] };
  }
  const detected = detectSecrets(raw);
  const safe = redactSecrets(raw).text;
  const base: ContentFields = { content_length: raw.length, redaction_kinds: detected };
  if (mode === 'metadata_only') return base;
  if (mode === 'full') {
    base.content = safe;
    base.content_summary = truncate(safe, 240);
    return base;
  }
  base.content_summary = truncate(safe, 240);
  return base;
}

export const FULL_EXPORT_WARNING =
  'Full-text export may include source code, business information and credentials. ' +
  'Known credential shapes are redacted, but no redaction is exhaustive. Review the package before sharing it.';
