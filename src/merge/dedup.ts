import { computeConflictEventId, computeEventId } from '../core/ids.js';
import { sha256, shortId, stableId } from '../core/hash.js';
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
   * Imported Al-exporter events folded into a native event by the original
   * source file + physical line + event type. This is deterministic identity
   * alignment for line-oriented formats (Codex ordinal, Cursor transcript).
   */
  line_pairs: number;
  /**
   * Imported Al-exporter events that were folded into a native event by
   * session id + event type + time + content. This pairing is inferred: the
   * two records are not proven to be the same underlying row.
   */
  inferred_pairs: number;
  /** Native-id / git-object / copied-session groups spanning more than one device. */
  cross_device_deterministic: number;
  /** Content-based cross-device candidate groups (events kept, never merged). */
  cross_device_candidates: number;
  /** Conflicting content under the same identity across devices. */
  cross_device_conflicts: number;
  /** Shipped events whose observers span more than one device. */
  cross_device_merged: number;
}

/** Capture method written by the Al-exporter import adapter. */
const IMPORT_CAPTURE_METHOD = 'adapter:al-exporter';

interface EmbeddedImportSource {
  event_id: string;
  dedup_key: string;
  capture_method?: string;
  source_path?: string;
  source_path_identity?: string;
  source_record_id?: string;
  source_line?: number;
  raw_payload_ref?: string;
  source_hash?: string;
  content_hash?: string;
  content_diverged: boolean;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Fold an Al-exporter import into its native counterpart while carrying the
 * import-side source references on the surviving event. The imported event is
 * not shipped, so a bare event id would be a dangling pointer. A differing
 * content hash is recorded explicitly instead of being silently discarded.
 */
function attachFoldedImport(
  native: ActivityEvent,
  imported: ActivityEvent,
  note: string,
  matchConfidence: 'exact' | 'candidate' = 'exact',
): ActivityEvent {
  const p = imported.provenance as Record<string, unknown>;
  const diverged = native.content_hash !== imported.content_hash;
  const embedded: EmbeddedImportSource = {
    event_id: imported.event_id,
    dedup_key: imported.dedup_key,
    capture_method: asOptionalString(p.capture_method),
    source_path: asOptionalString(p.source_path),
    source_path_identity: asOptionalString(p.source_path_identity),
    source_record_id: asOptionalString(p.source_record_id),
    source_line: typeof p.source_line === 'number' ? p.source_line : undefined,
    raw_payload_ref: asOptionalString(p.raw_payload_ref),
    source_hash: asOptionalString(p.source_hash),
    content_hash: imported.content_hash,
    content_diverged: diverged,
  };
  const fullNote = diverged
    ? `${note}; imported content differs (import content_hash=${imported.content_hash ?? 'absent'}) — divergence recorded, not discarded`
    : note;
  const prior = native.provenance.paired_import_sources as EmbeddedImportSource[] | undefined;
  const provenance: Record<string, unknown> = { ...(native.provenance as Record<string, unknown>) };
  delete provenance.paired_import_event_id; // legacy dangling pointer
  return {
    ...native,
    correlation: native.correlation
      ? {
          ...native.correlation,
          note: native.correlation.note ? `${native.correlation.note}; ${fullNote}` : fullNote,
        }
      : { kind: 'strongly_supported', match_confidence: matchConfidence, note: fullNote },
    provenance: {
      ...provenance,
      paired_import_sources: [...(Array.isArray(prior) ? prior : []), embedded],
    } as unknown as ActivityEvent['provenance'],
  };
}

type Observer = NonNullable<ActivityEvent['provenance']['observers']>[number];
type ObserverRelation = NonNullable<Observer['relation']>;

function observerOf(event: ActivityEvent, relation: ObserverRelation, diverged = false): Observer {
  return {
    device_id: event.device_id,
    scanner_device_id: event.scanner_device_id,
    source_path: event.provenance.source_path,
    source_path_identity: event.provenance.source_path_identity,
    source_record_id: event.provenance.source_record_id,
    capture_method: event.provenance.capture_method,
    capture_level: event.provenance.capture_level,
    observed_at: event.time.observed_at,
    content_hash: event.content_hash,
    content_diverged: diverged || undefined,
    relation,
  };
}

function observerKey(observer: Observer): string {
  return [
    observer.device_id,
    observer.scanner_device_id ?? '',
    observer.source_path_identity ?? observer.source_path ?? '',
    observer.source_record_id ?? '',
    observer.content_hash ?? '',
    observer.relation ?? '',
  ].join('\u0000');
}

function mergeObservers(event: ActivityEvent, added: readonly Observer[]): ActivityEvent {
  if (added.length === 0) return event;
  const map = new Map<string, Observer>();
  for (const observer of (event.provenance.observers ?? []) as Observer[]) {
    map.set(observerKey(observer), observer);
  }
  for (const observer of added) {
    const key = observerKey(observer);
    const prior = map.get(key);
    map.set(key, prior && prior.content_diverged ? prior : observer);
  }
  const observers = [...map.values()].sort((a, b) => observerKey(a).localeCompare(observerKey(b)));
  return {
    ...event,
    provenance: { ...event.provenance, observers } as ActivityEvent['provenance'],
  };
}

function appendNote(existing: string | undefined, extra: string): string {
  if (!existing) return extra;
  return existing.includes(extra) ? existing : `${existing}; ${extra}`;
}

function withCorrelationId(
  event: ActivityEvent,
  correlationId: string,
  note: string,
  relatedEventIds: readonly string[],
  kind: 'directly_observed' | 'time_based_inference',
  confidence: 'exact' | 'candidate',
): ActivityEvent {
  const prior = event.correlation;
  return {
    ...event,
    correlation_id: correlationId,
    correlation: {
      kind: prior?.kind ?? kind,
      match_confidence: prior?.match_confidence ?? confidence,
      note: appendNote(prior?.note, note),
      related_event_ids: [
        ...new Set([...(prior?.related_event_ids ?? []), ...relatedEventIds.filter((id) => id !== event.event_id)]),
      ].sort(),
    },
  };
}

function distinctDevices(events: readonly ActivityEvent[]): Set<string> {
  return new Set(events.map((event) => event.device_id));
}

/**
 * A source device can be scanned by several scanner devices (for example a
 * remote scan plus a local scan). That is more than one observation even though
 * the source_device_id is identical, so observers are keyed on both.
 */
function observationNodes(events: readonly ActivityEvent[]): Set<string> {
  return new Set(events.map((event) => `${event.device_id}\u0000${event.scanner_device_id ?? ''}`));
}

/**
 * Fold git commit events that describe the same commit object on different
 * devices. A Git SHA is content-addressed, so this is a deterministic identity,
 * not an inference. Commit events are folded in place (one canonical event with
 * per-device observers). Pushes are intentionally NOT folded: a push is
 * per-device evidence even when the commit is shared.
 */
function foldCrossDeviceGitCommits(
  events: readonly ActivityEvent[],
  inputTimelineIds: string[],
): { events: ActivityEvent[]; groups: number; conflicts: ConflictRecord[]; conflictGroups: number } {
  if (new Set(events.map((event) => event.device_id)).size < 2) {
    return { events: [...events], groups: 0, conflicts: [], conflictGroups: 0 };
  }
  const groups = new Map<string, ActivityEvent[]>();
  for (const event of events) {
    if (event.event_type !== 'git.commit.created') continue;
    const sha = event.git?.commit_sha;
    if (!sha) continue;
    const key = `${event.project_id}\u0000${sha.toLowerCase()}`;
    const list = groups.get(key);
    if (list) list.push(event);
    else groups.set(key, [event]);
  }

  const superseded = new Set<ActivityEvent>();
  const replacements = new Map<ActivityEvent, ActivityEvent>();
  const conflicts: ConflictRecord[] = [];
  let foldedGroups = 0;
  let conflictGroups = 0;

  for (const [key, group] of groups) {
    if (distinctDevices(group).size < 2) continue;
    foldedGroups += 1;
    const ordered = [...group].sort((a, b) => a.event_id.localeCompare(b.event_id));
    const primary = ordered[0]!;
    const byHash = new Map<string, ActivityEvent[]>();
    for (const event of ordered) {
      const hash = event.content_hash ?? '';
      const list = byHash.get(hash);
      if (list) list.push(event);
      else byHash.set(hash, [event]);
    }
    const hashes = [...byHash.keys()].sort();
    // The canonical event and the canonical hash must belong to the same
    // observation. Picking the smallest hash independently would overwrite the
    // canonical replacement when that hash belongs to another event.
    const primaryHash = primary.content_hash ?? '';
    const correlationId = shortId('corr', 'git', primary.project_id, primary.git?.commit_sha);
    const observations = (hash: string) =>
      (byHash.get(hash) ?? []).map((event) => observerOf(event, 'git_object', hash !== primaryHash));

    let canonical = mergeObservers(
      withCorrelationId(
        primary,
        correlationId,
        `same git commit ${primary.git?.commit_sha ?? ''} observed on ${distinctDevices(group).size} devices (deterministic SHA identity)`,
        [],
        'directly_observed',
        'exact',
      ),
      observations(primaryHash),
    );
    replacements.set(primary, canonical);
    for (const event of ordered.slice(1)) superseded.add(event);

    for (const hash of hashes.filter((h) => h !== primaryHash)) {
      const variantSource = byHash.get(hash)![0]!;
      const variant = mergeObservers(
        withCorrelationId(
          {
            ...variantSource,
            event_id: computeConflictEventId(key, hash),
          },
          correlationId,
          'same git commit SHA but differing event content; both versions preserved',
          [primary.event_id],
          'directly_observed',
          'exact',
        ),
        observations(hash),
      );
      replacements.set(variantSource, variant);
      conflicts.push({
        dedup_key: key,
        kept_event_id: primary.event_id,
        variant_event_id: variant.event_id,
        reason: 'same git commit object but different content hash across devices',
        input_timeline_ids: inputTimelineIds,
      });
      conflictGroups += 1;
    }
  }

  if (foldedGroups === 0) return { events: [...events], groups: 0, conflicts, conflictGroups: 0 };
  const output: ActivityEvent[] = [];
  for (const event of events) {
    const replacement = replacements.get(event);
    if (replacement) output.push(replacement);
    else if (!superseded.has(event)) output.push(event);
  }
  return { events: output, groups: foldedGroups, conflicts, conflictGroups };
}

/**
 * Content fingerprint for cross-device candidate correlation. Deliberately
 * excludes device, native ids and session ids: a copied session is handled
 * deterministically by the native-id tier instead. Matches here are only
 * candidates and never remove an event.
 */
function crossDeviceContentKey(event: ActivityEvent): string | undefined {
  const agent = event.agent;
  if (!agent?.agent_id) return undefined;
  const activity = event.activity ?? {};
  const content = activity.content ?? activity.content_summary;
  // Without real text there is not enough evidence for a cross-device
  // candidate; identical role/type/length alone is a coincidence.
  if (content === undefined || content.trim() === '') return undefined;
  if (!event.time.occurred_at) return undefined;
  return [
    event.project_id,
    agent.agent_id,
    event.event_type,
    event.time.occurred_at,
    activity.role ?? '',
    activity.tool_name ?? '',
    sha256(content),
  ].join('\u0000');
}

function correlateCrossDeviceContent(events: ActivityEvent[]): {
  events: ActivityEvent[];
  groups: number;
  mergedEvents: number;
} {
  if (new Set(events.map((event) => event.device_id)).size < 2) {
    return { events, groups: 0, mergedEvents: 0 };
  }
  const groups = new Map<string, ActivityEvent[]>();
  for (const event of events) {
    const key = crossDeviceContentKey(event);
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(event);
    else groups.set(key, [event]);
  }

  let groupsCount = 0;
  let mergedEvents = 0;
  const indexById = new Map(events.map((event, index) => [event.event_id, index]));
  for (const [key, group] of groups) {
    if (distinctDevices(group).size < 2) continue;
    const eligible = group.filter((event) => !event.correlation_id);
    if (distinctDevices(eligible).size < 2) continue;
    groupsCount += 1;
    const correlationId = stableId('corr', 'content', key);
    const ids = eligible.map((event) => event.event_id).sort();
    for (const event of eligible) {
      const at = indexById.get(event.event_id);
      if (at === undefined) continue;
      events[at] = withCorrelationId(
        event,
        correlationId,
        `cross-device content candidate across ${distinctDevices(eligible).size} devices; events preserved and not merged`,
        ids,
        'time_based_inference',
        'candidate',
      );
      mergedEvents += 1;
    }
  }
  return { events, groups: groupsCount, mergedEvents };
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
  // Deterministic pass first: an import row carrying the native message id is
  // the same record as the native row with that id, so no content heuristic is
  // involved. Removing it before grouping also avoids a false conflict variant.
  const deterministic = foldDeterministicImports(input);
  const lineFold = foldLineIdentityImports(deterministic.events, deterministic.pairedNative);
  // A Git SHA is the same object on every device: fold those before the
  // per-device dedup_key grouping.
  const gitFold = foldCrossDeviceGitCommits(lineFold.events, inputTimelineIds);
  const groups = new Map<string, ActivityEvent[]>();
  for (const event of gitFold.events) {
    const group = groups.get(event.dedup_key);
    if (group) group.push(event);
    else groups.set(event.dedup_key, [event]);
  }

  const kept: ActivityEvent[] = [];
  const conflicts: ConflictRecord[] = [...gitFold.conflicts];
  let duplicates = lineFold.events.length - gitFold.events.length;
  let crossDeviceDeterministic = gitFold.groups;
  let crossDeviceCandidates = 0;
  let crossDeviceConflicts = gitFold.conflictGroups;
  let crossDeviceMerged = 0;
  const canonicalEventId = (key: string) => computeEventId(key);

  for (const [key, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ordered = [...group].sort((a, b) => a.event_id.localeCompare(b.event_id));
    const byHash = new Map<string, ActivityEvent>();
    for (const event of ordered) {
      const hash = event.content_hash ?? '';
      if (!byHash.has(hash)) byHash.set(hash, event);
    }
    duplicates += ordered.length - byHash.size;

    const crossDevice = observationNodes(ordered).size > 1;
    const correlationId = crossDevice ? shortId('corr', 'native', key) : undefined;
    if (crossDevice) crossDeviceDeterministic += 1;

    const hashes = [...byHash.keys()].sort();
    const primaryHash = hashes[0] ?? '';
    const primarySource = byHash.get(primaryHash);
    if (!primarySource) continue;
    const primaryId = canonicalEventId(key);
    let primary: ActivityEvent = { ...primarySource, event_id: primaryId };
    if (crossDevice && correlationId) {
      const observations = ordered
        .filter((event) => (event.content_hash ?? '') === primaryHash)
        .map((event) => observerOf(event, 'same_native_id'));
      primary = mergeObservers(
        withCorrelationId(
          primary,
          correlationId,
          `same native event identity (${primarySource.dedup_tier}) observed by ${observationNodes(ordered).size} device/scanner combination(s)`,
          [],
          'directly_observed',
          'exact',
        ),
        observations,
      );
      if (observationNodes(ordered.filter((event) => (event.content_hash ?? '') === primaryHash)).size > 1) {
        crossDeviceMerged += 1;
      }
    }
    kept.push(primary);

    for (const hash of hashes.slice(1)) {
      const variantId = computeConflictEventId(key, hash);
      const source = byHash.get(hash)!;
      let variant: ActivityEvent = {
        ...source,
        event_id: variantId,
        correlation: {
          ...(source.correlation ?? {}),
          kind: source.correlation?.kind ?? 'directly_observed',
          note: 'conflicting variant of the same source record; both versions preserved',
          related_event_ids: [primaryId],
        },
      };
      if (crossDevice && correlationId) {
        const observations = ordered
          .filter((event) => (event.content_hash ?? '') === hash)
          .map((event) => observerOf(event, 'same_native_id'));
        variant = mergeObservers(
          withCorrelationId(
            variant,
            correlationId,
            'conflicting content under the same cross-device identity; both versions preserved',
            [primaryId],
            'directly_observed',
            'exact',
          ),
          observations,
        );
        crossDeviceConflicts += 1;
      }
      kept.push(variant);
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
  const correlation = correlateCrossDeviceContent(pairing.events);
  return {
    events: sortEvents(correlation.events),
    duplicates:
      duplicates + deterministic.deterministicPairs + lineFold.linePairs + pairing.inferredPairs,
    conflicts,
    deterministic_pairs: deterministic.deterministicPairs,
    line_pairs: lineFold.linePairs,
    inferred_pairs: pairing.inferredPairs,
    cross_device_deterministic: crossDeviceDeterministic,
    cross_device_candidates: crossDeviceCandidates + correlation.groups,
    cross_device_conflicts: crossDeviceConflicts,
    cross_device_merged: crossDeviceMerged,
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
  pairedNative: Set<ActivityEvent>;
} {
  const empty = {
    events: [...events],
    deterministicPairs: 0,
    pairedNative: new Set<ActivityEvent>(),
  };
  const imported = events.filter((event) => isImportedEvent(event));
  if (imported.length === 0) return empty;

  const nativeByIdentity = new Map<string, ActivityEvent>();
  for (const event of events) {
    if (isImportedEvent(event)) continue;
    const key = nativeIdentityKey(event);
    if (key && !nativeByIdentity.has(key)) nativeByIdentity.set(key, event);
  }
  if (nativeByIdentity.size === 0) return empty;

  const consumed = new Set<ActivityEvent>();
  const importsByNative = new Map<string, ActivityEvent>();
  const pairedNative = new Set<ActivityEvent>();
  for (const event of imported) {
    if (event.provenance.import_identity_source !== 'message_id') continue;
    const key = nativeIdentityKey(event);
    if (!key) continue;
    const native = nativeByIdentity.get(key);
    if (!native) continue;
    nativeByIdentity.delete(key);
    consumed.add(event);
    pairedNative.add(native);
    importsByNative.set(native.event_id, event);
  }
  if (consumed.size === 0) return empty;

  const output: ActivityEvent[] = [];
  for (const event of events) {
    if (consumed.has(event)) continue;
    const pairedImport = importsByNative.get(event.event_id);
    if (!pairedImport) {
      output.push(event);
      continue;
    }
    const note =
      `deterministic pairing with Al-exporter import ${pairedImport.event_id}: same agent, ` +
      'native session id and native message id';
    output.push(attachFoldedImport(event, pairedImport, note));
  }
  return { events: output, deterministicPairs: consumed.size, pairedNative };
}

/** Basename of the original agent file; the segment identity for rollout files. */
function sourceFileKey(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const normalized = raw.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return base || undefined;
}

/**
 * Identity of one physical row: project + device + agent + original file +
 * 1-based line + event type. Both the native parser and the Al-exporter archive
 * point at the same file, so this tuple is an identity, not an inference.
 */
function sourceLineIdentityKey(event: ActivityEvent, imported: boolean): string | undefined {
  const agent = event.agent;
  if (!agent?.agent_id) return undefined;
  const line = event.provenance.source_line;
  if (!line) return undefined;
  const file = sourceFileKey(
    imported
      ? (event.provenance.raw_payload_ref as string | undefined)
      : event.provenance.source_path,
  );
  if (!file) return undefined;
  return [event.project_id, event.device_id, agent.agent_id, file, line, event.event_type].join(
    '\u0000',
  );
}

/**
 * Fold imported `session_line` rows into the native row parsed from the same
 * original file and line. `messages[].line` is the 1-based physical line, so
 * Codex sessions whose `ordinal` is a thread-global counter still align.
 *
 * The fold requires the identity tuple to be unique on both sides: a line that
 * the exporter split into several rows (Cursor blocks, suffix `#n`) or a line
 * that produced several native events stays unfolded instead of guessing.
 */
function foldLineIdentityImports(
  events: readonly ActivityEvent[],
  alreadyPaired: ReadonlySet<ActivityEvent>,
): { events: ActivityEvent[]; linePairs: number } {
  const imported = events.filter(
    (event) => isImportedEvent(event) && event.provenance.import_identity_source === 'session_line',
  );
  if (imported.length === 0) return { events: [...events], linePairs: 0 };

  const nativeByKey = new Map<string, ActivityEvent[]>();
  for (const event of events) {
    if (isImportedEvent(event) || alreadyPaired.has(event)) continue;
    const key = sourceLineIdentityKey(event, false);
    if (!key) continue;
    const list = nativeByKey.get(key);
    if (list) list.push(event);
    else nativeByKey.set(key, [event]);
  }
  if (nativeByKey.size === 0) return { events: [...events], linePairs: 0 };

  const importCounts = new Map<string, number>();
  for (const event of imported) {
    const key = sourceLineIdentityKey(event, true);
    if (key) importCounts.set(key, (importCounts.get(key) ?? 0) + 1);
  }

  const consumed = new Set<ActivityEvent>();
  const importsByNative = new Map<string, ActivityEvent>();
  const pairedNative = new Set<ActivityEvent>();
  for (const event of imported) {
    const key = sourceLineIdentityKey(event, true);
    if (!key) continue;
    if (importCounts.get(key) !== 1) continue;
    const native = nativeByKey.get(key);
    if (!native || native.length !== 1) continue;
    consumed.add(event);
    pairedNative.add(native[0]!);
    importsByNative.set(native[0]!.event_id, event);
  }
  if (consumed.size === 0) return { events: [...events], linePairs: 0 };

  const output: ActivityEvent[] = [];
  for (const event of events) {
    if (consumed.has(event)) continue;
    const pairedImport = importsByNative.get(event.event_id);
    if (!pairedImport) {
      output.push(event);
      continue;
    }
    const note =
      `deterministic pairing with Al-exporter import ${pairedImport.event_id}: same agent, ` +
      `source file and line ${event.provenance.source_line}`;
    output.push(attachFoldedImport(event, pairedImport, note));
  }
  return { events: output, linePairs: consumed.size };
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
  const paired = new Map<string, ActivityEvent>();
  for (const event of imported) {
    const key = pairingFingerprint(event);
    if (!key) continue;
    const native = nativeByKey.get(key);
    if (!native) continue;
    nativeByKey.delete(key);
    consumed.add(event);
    paired.set(native.event_id, event);
  }
  if (paired.size === 0) return { events, inferredPairs: 0 };

  const output: ActivityEvent[] = [];
  for (const event of events) {
    if (event.provenance.capture_method === IMPORT_CAPTURE_METHOD) {
      if (!consumed.has(event)) output.push(event);
      continue;
    }
    const pairedImport = paired.get(event.event_id);
    if (!pairedImport) {
      output.push(event);
      continue;
    }
    const note =
      `inferred pairing with Al-exporter import ${pairedImport.event_id}: same agent, session id, event type, ` +
      'time and content; the records are not confirmed identical';
    output.push(attachFoldedImport(event, pairedImport, note, 'candidate'));
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
