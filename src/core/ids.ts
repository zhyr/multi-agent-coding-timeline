import { hashObject, shortId, stableId } from './hash.js';

/**
 * Canonicalize a Git remote URL so that the same repository is recognized
 * across SSH/HTTPS forms and across devices with different mount points.
 */
export function normalizeRemoteUrl(raw: string): string {
  let url = raw.trim();
  if (!url) return '';
  // git@host:owner/repo(.git) -> https://host/owner/repo
  const scp = /^[^@]+@([^:]+):(.+)$/.exec(url);
  if (scp) url = `https://${scp[1]}/${scp[2]}`;
  url = url.replace(/^[a-z+]+:\/\/[^@/]+@/i, (m) => m.replace(/[^@/]+@/, ''));
  url = url.replace(/\/+$/, '');
  url = url.replace(/\.git$/i, '');
  const parsed = /^([a-z+]+):\/\/([^/]+)(\/.*)?$/i.exec(url);
  if (parsed) url = `${parsed[1]!.toLowerCase()}://${parsed[2]!.toLowerCase()}${parsed[3] ?? ''}`;
  return url.toLowerCase().replace(/\/$/, '');
}

export interface ProjectIdInput {
  canonicalRemoteUrl?: string;
  repositoryIdentity?: string;
  projectName: string;
  explicitProjectId?: string;
}

export type ProjectIdBasis = 'explicit' | 'remote' | 'repository' | 'name';

export interface ProjectIdResult {
  projectId: string;
  basis: ProjectIdBasis;
  /** false means identity is weak and must not be silently merged across devices. */
  strong: boolean;
}

/**
 * Project identity must never be derived from the project name alone when
 * stronger evidence exists. Name-derived IDs are explicitly marked weak so the
 * merge engine can refuse to combine them without user confirmation.
 */
export function computeProjectId(input: ProjectIdInput): ProjectIdResult {
  if (input.explicitProjectId) {
    return { projectId: input.explicitProjectId, basis: 'explicit', strong: true };
  }
  const remote = input.canonicalRemoteUrl ? normalizeRemoteUrl(input.canonicalRemoteUrl) : '';
  if (remote) {
    return { projectId: shortId('proj', 'remote', remote), basis: 'remote', strong: true };
  }
  if (input.repositoryIdentity) {
    return {
      projectId: shortId('proj', 'repository', input.repositoryIdentity),
      basis: 'repository',
      strong: true,
    };
  }
  return {
    projectId: shortId('proj', 'name', input.projectName.toLowerCase()),
    basis: 'name',
    strong: false,
  };
}

/** Session identity keeps the native ID but namespaces it by device + agent. */
export function computeSessionId(deviceId: string, agentId: string, nativeSessionId: string): string {
  return shortId('sess', deviceId, agentId, nativeSessionId);
}

export function computeDeviceId(explicit: string | undefined, fallback: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  return `device-${shortId('dev', fallback).slice(5, 21)}`;
}

export interface DedupInput {
  agentId?: string;
  nativeSessionId?: string;
  nativeEventId?: string;
  sourceDeviceId: string;
  /** Path relative to the scan source root; stable across mount points. */
  sourcePathIdentity?: string;
  sourcePath?: string;
  sourceRecordId?: string;
  sessionId?: string;
  eventType: string;
  occurredAt?: string;
  contentHash: string;
}

export type DedupTier = 'native_id' | 'source_location' | 'content_assisted';

export interface DedupKeyResult {
  dedupKey: string;
  tier: DedupTier;
}

/**
 * Three-tier deterministic deduplication.
 * Content-assisted dedup ALWAYS includes session + time + event type: identical
 * user text in two different sessions are two real activities and must survive.
 */
export function computeDedupKey(input: DedupInput): DedupKeyResult {
  if (input.nativeEventId && input.agentId && input.nativeSessionId) {
    return {
      dedupKey: stableId('dedup:native', input.agentId, input.nativeSessionId, input.nativeEventId),
      tier: 'native_id',
    };
  }
  const pathIdentity = input.sourcePathIdentity ?? input.sourcePath;
  if (pathIdentity && input.sourceRecordId !== undefined) {
    return {
      dedupKey: stableId('dedup:source', input.sourceDeviceId, pathIdentity, input.sourceRecordId),
      tier: 'source_location',
    };
  }
  return {
    dedupKey: stableId(
      'dedup:content',
      input.sourceDeviceId,
      input.agentId ?? '',
      input.sessionId ?? '',
      input.eventType,
      input.occurredAt ?? '',
      input.contentHash,
    ),
    tier: 'content_assisted',
  };
}

export function computeEventId(dedupKey: string): string {
  return shortId('evt', dedupKey);
}

/** Distinct ID for a conflicting variant of the same source record. */
export function computeConflictEventId(dedupKey: string, contentHash: string): string {
  return shortId('evt', 'variant', dedupKey, contentHash);
}

/**
 * Fields that define event content.
 *
 * Deliberately excludes the device-scoped session id, scanner identity, parser
 * version and source path: the same record copied or synced to another device
 * must hash identically, otherwise cross-device deterministic correlation sees
 * a false conflict. True content divergence (activity, time, agent native ids,
 * git data) still produces a different hash.
 */
export function computeContentHash(event: {
  event_type: string;
  time?: { occurred_at?: string };
  agent?: unknown;
  activity?: unknown;
  git?: unknown;
}): string {
  return hashObject({
    event_type: event.event_type,
    occurred_at: event.time?.occurred_at ?? null,
    agent: event.agent ?? null,
    activity: event.activity ?? null,
    git: event.git ?? null,
  });
}

export function computeTimelineId(operation: 'scan' | 'merge', projectId: string, inputs: string[]): string {
  return shortId('tln', operation, projectId, [...inputs].sort());
}

export function computeChecksumLine(relativePath: string, hash: string): string {
  return `${hash}  ${relativePath}`;
}
