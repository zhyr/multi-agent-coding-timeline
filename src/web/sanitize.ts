/**
 * Sanitize a ViewerModel before it is shown in the web UI.
 *
 * The scanner honestly records every discovered source, including sources it
 * excluded because they belong to other projects. Some of those source paths
 * may reference repositories the user does not want surfaced in this app.
 * This module strips any record whose serialised form mentions a blocked path
 * token, and keeps the model's counts consistent.
 */
import type { ViewerModel } from '../viewer/build.js';

/** Path tokens that must never appear in the interactive app's UI. */
export const BLOCKED_PATH_TOKENS: readonly string[] = ['yuelideck'];

function mentionsBlocked(value: unknown): boolean {
  if (value == null) return false;
  const text = JSON.stringify(value).toLowerCase();
  return BLOCKED_PATH_TOKENS.some((token) => text.includes(token.toLowerCase()));
}

/** Recursively drop blocked entries from arrays and blocked string values from objects. */
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((item) => !mentionsBlocked(item)).map(scrub);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string' && mentionsBlocked(v)) continue;
      out[k] = scrub(v);
    }
    return out;
  }
  return value;
}

/** Return a sanitized copy; the input model is never mutated. */
export function sanitizeViewerModel(model: ViewerModel): ViewerModel {
  const clean = scrub(model) as ViewerModel;
  if (clean.meta?.counts) {
    clean.meta.counts.sources = Array.isArray(clean.sources) ? clean.sources.length : 0;
  }
  return clean;
}
