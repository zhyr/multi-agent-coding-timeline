/**
 * Background job registry with SSE event streaming.
 *
 * Jobs are in-process, keyed by an incrementing id. Each job emits progress
 * messages consumed by the browser via Server-Sent Events. No persistence of
 * jobs is needed: scan *results* are persisted to the catalog/packages, jobs
 * are only progress transports.
 */
import { randomUUID } from 'node:crypto';
import type { RepositoryEntry } from './discovery.js';

export type JobStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface JobEvent {
  type: 'progress' | 'done' | 'error';
  message: string;
  progress?: number;
  data?: unknown;
  at: string;
}

export interface Job {
  id: string;
  kind: 'scan-repos' | 'scan-project';
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  events: JobEvent[];
  result?: unknown;
  error?: string;
  /** Listeners waiting for new events. */
  listeners: Set<(event: JobEvent) => void>;
}

const jobs = new Map<string, Job>();

export function createJob(kind: Job['kind']): Job {
  const id = randomUUID();
  const now = new Date().toISOString();
  const job: Job = {
    id, kind, status: 'running', createdAt: now, updatedAt: now,
    events: [], listeners: new Set(),
  };
  jobs.set(id, job);
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function emit(job: Job, event: Omit<JobEvent, 'at'>): void {
  const full: JobEvent = { ...event, at: new Date().toISOString() };
  job.events.push(full);
  job.updatedAt = full.at;
  if (event.type === 'done') { job.status = 'done'; job.result = event.data; }
  if (event.type === 'error') { job.status = 'error'; job.error = event.message; }
  for (const listener of job.listeners) {
    try { listener(full); } catch { /* a broken listener must not break the job */ }
  }
}

export function subscribe(job: Job, listener: (event: JobEvent) => void): () => void {
  job.listeners.add(listener);
  return () => job.listeners.delete(listener);
}

/** Replay all events so a late SSE client sees the current state. */
export function snapshot(job: Job): { status: JobStatus; result?: unknown; error?: string; events: JobEvent[] } {
  return { status: job.status, result: job.result, error: job.error, events: job.events };
}

/** Prune finished jobs older than ttlMs. Called periodically by the server. */
export function pruneJobs(ttlMs = 30 * 60 * 1000): void {
  const cutoff = Date.now() - ttlMs;
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && Date.parse(job.updatedAt) < cutoff) jobs.delete(id);
  }
}

/** Result payload of a repository-discovery job. */
export interface ScanReposResult {
  repositories: RepositoryEntry[];
  total: number;
  keyword: string;
}

/** Result payload of a project-scan job. */
export interface ScanProjectResult {
  projectId: string;
  eventCount: number;
  reused: boolean;
}
