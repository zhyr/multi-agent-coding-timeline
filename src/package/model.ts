import type {
  ActivityEvent,
  AgentIdentity,
  ConflictRecord,
  EventRelation,
  GitCommitRecord,
  GitPushRecord,
  Manifest,
  MergeReport,
  ScanInputs,
  ScanReport,
  SessionRecord,
  SourceEntry,
  TaskRecord,
  TimelineDevice,
  TimelineProject,
} from '../schema/entities.js';

/** In-memory representation of a Timeline Package. All collections are arrays; JSONL on disk. */
export interface TimelineData {
  manifest: Manifest;
  project: TimelineProject;
  devices: TimelineDevice[];
  agents: AgentIdentity[];
  sessions: SessionRecord[];
  tasks: TaskRecord[];
  events: ActivityEvent[];
  relations: EventRelation[];
  commits: GitCommitRecord[];
  pushes: GitPushRecord[];
  sources: SourceEntry[];
  scanInputs?: ScanInputs;
  scanReport?: ScanReport;
  mergeReport?: MergeReport;
  conflicts: ConflictRecord[];
}

export function emptyTimeline(): TimelineData {
  return {
    manifest: {} as Manifest,
    project: {} as TimelineProject,
    devices: [],
    agents: [],
    sessions: [],
    tasks: [],
    events: [],
    relations: [],
    commits: [],
    pushes: [],
    sources: [],
    conflicts: [],
  };
}

export interface TimelineCounts {
  events: number;
  sessions: number;
  agents: number;
  commits: number;
  devices: number;
}

export function timelineCounts(data: TimelineData): TimelineCounts {
  return {
    events: data.events.length,
    sessions: data.sessions.length,
    agents: data.agents.length,
    commits: data.commits.length,
    devices: data.devices.length,
  };
}
