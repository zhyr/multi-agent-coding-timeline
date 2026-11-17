import { CONTENT_MODES } from '../core/constants.js';
import type { ValidationResult } from '../package/validate.js';

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

export function progressLine(quiet: boolean, message: string): void {
  if (!quiet) process.stderr.write(`[aitimeline] ${message}\n`);
}

export function printError(message: string): void {
  process.stderr.write(`aitimeline: error: ${message}\n`);
}

export function printValidation(result: ValidationResult, title = 'Timeline Package'): void {
  process.stdout.write(`${title} validation: ${result.ok ? 'PASS' : 'FAIL'}\n`);
  for (const check of result.checks) {
    process.stdout.write(`  ${check.ok ? 'ok  ' : 'FAIL'} ${check.name}${check.detail ? ` — ${check.detail}` : ''}\n`);
  }
  process.stdout.write(
    `  Records: ${result.stats.events} events, ${result.stats.sessions} sessions, ${result.stats.agents} agents, ` +
      `${result.stats.commits} commits, ${result.stats.pushes} pushes, ${result.stats.relations} relations\n`,
  );
  for (const warning of result.warnings) process.stdout.write(`  warning: ${warning}\n`);
  for (const error of result.errors) process.stdout.write(`  error: ${error}\n`);
}

export function parseAgents(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value.split(',').map((v) => v.trim()).filter(Boolean);
}

export function parseContentMode(value: string | undefined): (typeof CONTENT_MODES)[number] {
  if (!value) return 'summary';
  if (!(CONTENT_MODES as readonly string[]).includes(value)) {
    throw new Error(`invalid --content-mode "${value}"; expected one of ${CONTENT_MODES.join(', ')}`);
  }
  return value as (typeof CONTENT_MODES)[number];
}

export function truncate(text: string, limit = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}
