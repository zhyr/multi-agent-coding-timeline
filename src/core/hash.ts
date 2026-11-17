import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** SHA-256 hex digest of a string or buffer. */
export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Deterministic JSON serialization with sorted object keys.
 * Used for content hashing and stable IDs so that key insertion order never
 * changes an identifier, including across devices and Node versions.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const child = source[key];
      if (child === undefined) continue;
      out[key] = canonicalize(child);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value;
}

/** Hash of an arbitrary JSON-serializable structure, independent of key order. */
export function hashObject(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** Stable, namespaced identifier derived from canonical parts. */
export function stableId(namespace: string, ...parts: unknown[]): string {
  return sha256(`${namespace}\u0000${parts.map((p) => (typeof p === 'string' ? p : canonicalJson(p))).join('\u0000')}`);
}

/** Short, human-readable but still deterministic identifier. */
export function shortId(namespace: string, ...parts: unknown[]): string {
  return `${namespace}_${stableId(namespace, ...parts).slice(0, 32)}`;
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
