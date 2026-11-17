import { computeConflictEventId, computeEventId } from '../core/ids.js';
import type { ActivityEvent, ConflictRecord } from '../schema/entities.js';

export interface DedupResult {
  events: ActivityEvent[];
  duplicates: number;
  conflicts: ConflictRecord[];
  /**
   * Imported Al-exporter events folded into a native event by the same agent,
   * native session id and native message id. This is deterministic identity
   * alignment, not an inference.
   */
  deterministic_pairs: number;
  /**
   * Imported Al-exporter events that were folded into a native event by
   * session id + event type + time + content. This pairing is inferred: the
   * two records are not proven to be the same underlying row.
   */
  inferred_pairs: number;
}

/** Capture method written by the Al-exporter import adapter. */
const IMPORT_CAPTURE_METHOD = 'adapter:al-exporter';

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
  // Deterministic pass first: an import row carrying the native message id is
  // the same record as the native row with that id, so no content heuristic is
  // involved. Removing it before grouping also avoids a false conflict variant.
  const deterministic = foldDeterministicImports(input);
  const groups = new Map<string, ActivityEvent[]>();
  for (const event of deterministic.events) {
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

  const pairing = pairImportedEvents(kept);
  return {
    events: sortEvents(pairing.events),
    duplicates: duplicates + deterministic.deterministicPairs + pairing.inferredPairs,
    conflicts,
    deterministic_pairs: deterministic.deterministicPairs,
    inferred_pairs: pairing.inferredPairs,
  };
}

/** Identity tuple shared by native scans and 1.1.0 imports. */
function nativeIdentityKey(event: ActivityEvent): string | undefined {
  const agent = event.agent;
  if (!agent?.agent_id || !agent.native_session_id || !agent.native_event_id) return undefined;
  return [
    event.project_id,
    event.device_id,
    agent.agent_id,
    agent.native_session_id,
    agent.native_event_id,
  ].join('\u0000');
}

function isImportedEvent(event: ActivityEvent): boolean {
  return event.provenance.capture_method === IMPORT_CAPTURE_METHOD;
}

/**
 * Fold imported events whose `agent.native_event_id` came from
 * `messages[].id`. The native and imported rows then share the exact identity
 * tuple used by the `native_id` dedup tier, so the fold is deterministic.
 * Rows that fell back to `session:<id>:L<line>` do not participate; they are
 * handled by the inferred pairing pass or kept as independent events.
 */
function foldDeterministicImports(events: readonly ActivityEvent[]): {
  events: ActivityEvent[];
  deterministicPairs: number;
} {
  const imported = events.filter((event) => isImportedEvent(event));
  if (imported.length === 0) return { events: [...events], deterministicPairs: 0 };

  const nativeByIdentity = new Map<string, ActivityEvent>();
  for (const event of events) {
    if (isImportedEvent(event)) continue;
    const key = nativeIdentityKey(event);
    if (key && !nativeByIdentity.has(key)) nativeByIdentity.set(key, event);
  }
  if (nativeByIdentity.size === 0) return { events: [...events], deterministicPairs: 0 };

  const consumed = new Set<ActivityEvent>();
  const importIdByNative = new Map<string, string>();
  for (const event of imported) {
    if (event.provenance.import_identity_source !== 'message_id') continue;
    const key = nativeIdentityKey(event);
    if (!key) continue;
    const native = nativeByIdentity.get(key);
    if (!native) continue;
    nativeByIdentity.delete(key);
    consumed.add(event);
    importIdByNative.set(native.event_id, event.event_id);
  }
  if (consumed.size === 0) return { events: [...events], deterministicPairs: 0 };

  const output: ActivityEvent[] = [];
  for (const event of events) {
    if (consumed.has(event)) continue;
    const importId = importIdByNative.get(event.event_id);
    if (!importId) {
      output.push(event);
      continue;
    }
    const note =
      `deterministic pairing with Al-exporter import ${importId}: same agent, ` +
      'native session id and native message id';
    output.push({
      ...event,
      correlation: event.correlation
        ? {
            ...event.correlation,
            note: event.correlation.note ? `${event.correlation.note}; ${note}` : note,
          }
        : { kind: 'strongly_supported', match_confidence: 'exact', note },
      provenance: { ...event.provenance, paired_import_event_id: importId },
    });
  }
  return { events: output, deterministicPairs: consumed.size };
}

/**
 * Pair an imported Al-exporter event with the native event it was exported from.
 *
 * Imported events can carry the agent-native session id recovered from
 * `meta.file_path`, but never the native event/line id. The primary dedup key
 * therefore cannot match across import and native scans. This pass folds the
 * two sides together only when the agent, native session id, event type,
 * occurred_at and content all agree, and labels the result as an inference.
 * When any of those differ the imported event is kept, so unmatched variants
 * remain visible instead of being silently merged.
 */
function pairingFingerprint(event: ActivityEvent): string | undefined {
  const agent = event.agent;
  if (!agent?.native_session_id) return undefined;
  const activity = event.activity ?? {};
  const content = activity.content ?? activity.content_summary;
  const body =
    content !== undefined
      ? `text:${content}`
      : `len:${activity.content_length ?? ''}|role:${activity.role ?? ''}|tool:${activity.tool_name ?? ''}`;
  return [
    event.project_id,
    event.device_id,
    agent.agent_id,
    agent.native_session_id,
    event.event_type,
    event.time.occurred_at ?? '',
    body,
  ].join('\u0000');
}

function pairImportedEvents(events: ActivityEvent[]): { events: ActivityEvent[]; inferredPairs: number } {
  const imported = events.filter((event) => event.provenance.capture_method === IMPORT_CAPTURE_METHOD);
  if (imported.length === 0) return { events, inferredPairs: 0 };

  const nativeByKey = new Map<string, ActivityEvent>();
  for (const event of events) {
    if (event.provenance.capture_method === IMPORT_CAPTURE_METHOD) continue;
    const key = pairingFingerprint(event);
    if (key && !nativeByKey.has(key)) nativeByKey.set(key, event);
  }

  const consumed = new Set<ActivityEvent>();
  const paired = new Map<string, string>();
  for (const event of imported) {
    const key = pairingFingerprint(event);
    if (!key) continue;
    const native = nativeByKey.get(key);
    if (!native) continue;
    nativeByKey.delete(key);
    consumed.add(event);
    paired.set(native.event_id, event.event_id);
  }
  if (paired.size === 0) return { events, inferredPairs: 0 };

  const output: ActivityEvent[] = [];
  for (const event of events) {
    if (event.provenance.capture_method === IMPORT_CAPTURE_METHOD) {
      if (!consumed.has(event)) output.push(event);
      continue;
    }
    const importId = paired.get(event.event_id);
    if (!importId) {
      output.push(event);
      continue;
    }
    const note =
      `inferred pairing with Al-exporter import ${importId}: same agent, session id, event type, ` +
      'time and content; the records are not confirmed identical';
    output.push({
      ...event,
      correlation: event.correlation
        ? {
            ...event.correlation,
            note: event.correlation.note ? `${event.correlation.note}; ${note}` : note,
          }
        : { kind: 'strongly_supported', match_confidence: 'candidate', note },
      provenance: { ...event.provenance, paired_import_event_id: importId },
    });
  }
  return { events: output, inferredPairs: paired.size };
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
