import { computeConflictEventId, computeEventId } from '../core/ids.js';
import type { ActivityEvent, ConflictRecord } from '../schema/entities.js';

export interface DedupResult {
  events: ActivityEvent[];
  duplicates: number;
  conflicts: ConflictRecord[];
}

/** Deterministic ordering for both scan and merge. */
export function sortEvents(events: ActivityEvent[]): ActivityEvent[] {
  return [...events].sort((a, b) => {
    const ta = a.time.occurred_at ?? a.time.observed_at;
    const tb = b.time.occurred_at ?? b.time.observed_at;
    if (ta !== tb) return ta.localeCompare(tb);
    if (a.device_id !== b.device_id) return a.device_id.localeCompare(b.device_id);
    const sa = a.session_id ?? '';
    const sb = b.session_id ?? '';
    if (sa !== sb) return sa.localeCompare(sb);
    const qa = a.sequence_hint ?? Number.MAX_SAFE_INTEGER;
    const qb = b.sequence_hint ?? Number.MAX_SAFE_INTEGER;
    if (qa !== qb) return qa - qb;
    return a.event_id.localeCompare(b.event_id);
  });
}

/**
 * Idempotent, deterministic deduplication.
 *
 * Records are grouped by dedup_key first (NOT by event_id). Within a group,
 * one canonical event per distinct content hash survives. Additional distinct
 * hashes become explicitly labelled conflict variants. This guarantees that:
 *   - identical re-imports collapse to exactly one event;
 *   - conflicting versions of the same source record are never discarded;
 *   - re-merging an already merged package produces no new events.
 */
export function deduplicateEvents(
  input: readonly ActivityEvent[],
  inputTimelineIds: string[] = [],
): DedupResult {
  const groups = new Map<string, ActivityEvent[]>();
  for (const event of input) {
    const group = groups.get(event.dedup_key);
    if (group) group.push(event);
    else groups.set(event.dedup_key, [event]);
  }

  const kept: ActivityEvent[] = [];
  const conflicts: ConflictRecord[] = [];
  let duplicates = 0;
  const canonicalEventId = (key: string) => computeEventId(key);

  for (const [key, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ordered = [...group].sort((a, b) => a.event_id.localeCompare(b.event_id));
    const byHash = new Map<string, ActivityEvent>();
    for (const event of ordered) {
      const hash = event.content_hash ?? '';
      if (!byHash.has(hash)) byHash.set(hash, event);
    }
    duplicates += ordered.length - byHash.size;

    const hashes = [...byHash.keys()].sort();
    const primaryHash = hashes[0] ?? '';
    const primarySource = byHash.get(primaryHash);
    if (!primarySource) continue;
    const primaryId = canonicalEventId(key);
    kept.push({ ...primarySource, event_id: primaryId });

    for (const hash of hashes.slice(1)) {
      const variantId = computeConflictEventId(key, hash);
      const source = byHash.get(hash)!;
      kept.push({
        ...source,
        event_id: variantId,
        correlation: {
          ...(source.correlation ?? {}),
          kind: source.correlation?.kind ?? 'directly_observed',
          note: 'conflicting variant of the same source record; both versions preserved',
          related_event_ids: [primaryId],
        },
      });
      conflicts.push({
        dedup_key: key,
        kept_event_id: primaryId,
        variant_event_id: variantId,
        reason: 'same dedup key but different content hash',
        input_timeline_ids: inputTimelineIds,
      });
    }
  }

  return { events: sortEvents(kept), duplicates, conflicts };
}

/** Deterministic merge of record collections keyed by an explicit ID. */
export function mergeById<T>(collections: readonly (readonly T[])[], key: (item: T) => string): T[] {
  const map = new Map<string, T>();
  for (const collection of collections) {
    for (const item of collection) {
      const k = key(item);
      if (!map.has(k)) map.set(k, item);
    }
  }
  return [...map.values()].sort((a, b) => key(a).localeCompare(key(b)));
}
