import type { TimelineData } from '../package/model.js';
import type { ActivityEvent } from '../schema/entities.js';

/** A flattened, render-ready projection of one ActivityEvent. */
export interface ViewerEvent {
  id: string;
  at: string;
  sortBasis: 'occurred_at' | 'observed_at_fallback' | 'unknown';
  type: string;
  agentId: string;
  agentName: string;
  deviceId: string;
  sessionId?: string;
  taskId?: string;
  evidence: string;
  confidence?: number;
  title: string;
  body?: string;
  toolName?: string;
  executionStatus?: string;
  errorMessage?: string;
  commit?: string;
  branch?: string;
  files?: string[];
  relationKind?: string;
  relationNote?: string;
  matchConfidence?: string;
  provenance: {
    sourceType: string;
    sourcePath?: string;
    sourceIdentity?: string;
    sourceRecordId?: string;
    captureMethod: string;
    captureLevel: string;
    sourceHash?: string;
  };
  parser: { adapterId: string; adapterVersion: string; parserVersion: string };
  /** Who produced this message/event: user, the main agent, a subagent, or a non-chat source. */
  sender: {
    kind: 'user' | 'agent' | 'subagent' | 'source';
    label: string;
    agentName?: string;
    detail?: string;
  };
  redactionKinds?: string[];
  sequence?: number;
}

export interface ViewerModel {
  meta: {
    title: string;
    projectId: string;
    projectName: string;
    identityBasis: string;
    identityStrong: boolean;
    operation: string;
    timelineId: string;
    contentMode: string;
    schemaVersion: string;
    formatVersion: string;
    createdAt: string;
    generatedAt: string;
    sourceDevices: string[];
    counts: {
      events: number;
      sessions: number;
      agents: number;
      devices: number;
      commits: number;
      pushes: number;
      tasks: number;
      sources: number;
      conflicts: number;
    };
  };
  events: ViewerEvent[];
  sessions: Array<{
    id: string;
    agent: string;
    device: string;
    nativeId: string;
    source: string;
    sourceIdentity: string;
    firstSeen?: string;
    lastSeen?: string;
    eventCount: number;
    matchConfidence: string;
    matchBasis?: string;
    incomplete?: boolean;
  }>;
  agents: Array<{
    id: string;
    name: string;
    version: string;
    verification?: string;
    formats?: string;
    capabilities: Record<string, string>;
  }>;
  devices: Array<{
    id: string;
    name?: string;
    platform?: string;
    role?: string;
    scannerDeviceId?: string;
  }>;
  commits: Array<{
    sha: string;
    short: string;
    device: string;
    branch?: string;
    message?: string;
    author?: string;
    at?: string;
    files?: number;
    insertions?: number;
    deletions?: number;
    changedFiles?: string[];
    parents: string[];
  }>;
  sources: Array<{
    id: string;
    agent: string;
    device: string;
    path: string;
    identity: string;
    type: string;
    status: string;
    records?: number;
    malformed?: number;
    bytes?: number;
    modifiedAt?: string;
    reason?: string;
    sha256?: string;
  }>;
  reports: {
    scan?: NonNullable<TimelineData['scanReport']>;
    merge?: NonNullable<TimelineData['mergeReport']>;
    conflicts: Array<{ dedupKey: string; kept: string; variant: string; reason: string; inputs: string[] }>;
  };
  warnings: string[];
}

export interface ViewerOptions {
  /** Override the document title; defaults to "<project> — AI Coding Timeline". */
  title?: string;
  /** Injected clock for deterministic tests. */
  generatedAt?: string;
}

const SUMMARY_LIMIT = 240;
const BODY_LIMIT = 20_000;

function compact(text: string | undefined, limit: number): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

function eventTitle(event: ActivityEvent, allowContent: boolean): string {
  const activity = event.activity;
  if (!allowContent) return activity?.tool_name ?? event.event_type;
  return (
    compact(activity?.content_summary, SUMMARY_LIMIT) ??
    compact(activity?.content, SUMMARY_LIMIT) ??
    compact(activity?.tool_name, SUMMARY_LIMIT) ??
    compact(event.git?.commit_sha?.slice(0, 12), SUMMARY_LIMIT) ??
    event.event_type
  );
}

function eventBody(event: ActivityEvent, allowContent: boolean): string | undefined {
  if (!allowContent) return undefined;
  const content = event.activity?.content;
  if (!content) return undefined;
  return content.length <= BODY_LIMIT ? content : `${content.slice(0, BODY_LIMIT)}\n… (truncated in viewer)`;
}

/** Extract a readable subagent name from a native session id or source path. */
function subagentName(event: ActivityEvent): string | undefined {
  const native = event.agent?.native_session_id;
  const candidates: string[] = [];
  if (native && /subagent|agent-/i.test(native)) candidates.push(native);
  const p = event.provenance?.source_path;
  if (p && /\/subagents\//i.test(p)) {
    const tail = p.split('/').pop() ?? '';
    candidates.push(tail.replace(/\.jsonl(?:\.zst)?$/i, ''));
  }
  for (const raw of candidates) {
    // e.g. "agent-a【示例】研究助手-462a2edd90c83e7f" -> "agent-a【示例】研究助手"
    const cleaned = raw
      .replace(/-[0-9a-f]{8,}$/i, '')
      .replace(/^[0-9a-f-]{36}$/i, '')
      .trim();
    if (cleaned && !/^[0-9a-f-]+$/i.test(cleaned)) return cleaned;
  }
  return undefined;
}

/** Derive who sent/produced an event. Never upgrades evidence; purely interpretive labels. */
function eventSender(event: ActivityEvent, agentName: string): ViewerEvent['sender'] {
  const role = (event.activity?.role ?? '').toLowerCase();
  const agent = event.agent?.agent_id ?? '';
  const isGit = event.event_type.startsWith('git.') || (!event.agent && !event.activity?.role);

  if (role === 'user') {
    return { kind: 'user', label: '用户', detail: agentName !== 'Git' ? `→ ${agentName}` : undefined };
  }
  const isSubagent = /\/subagents\//i.test(event.provenance?.source_path ?? '') ||
    /subagent/i.test(event.agent?.native_session_id ?? '');
  if (isSubagent) {
    const name = subagentName(event);
    return {
      kind: 'subagent',
      label: '子代理',
      agentName,
      detail: name ? `${agentName} · ${name}` : agentName,
    };
  }
  if (role === 'assistant') {
    return { kind: 'agent', label: 'Agent', agentName, detail: agentName };
  }
  if (isGit || agent === 'git') {
    return { kind: 'source', label: 'Git', detail: '版本控制' };
  }
  return { kind: 'source', label: agentName || '系统', detail: role || undefined };
}

/** Build the render model. Never upgrades evidence levels or invents fields. */
export function buildViewerModel(data: TimelineData, options: ViewerOptions = {}): ViewerModel {
  const manifest = data.manifest;
  const allowContent = manifest.content_mode !== 'metadata_only';
  const agentNames = new Map(data.agents.map((a) => [a.agent_id, a.agent_name]));
  const warnings: string[] = [...(data.scanReport?.warnings ?? []), ...(data.mergeReport?.warnings ?? [])];

  const events: ViewerEvent[] = data.events
    .map((event) => ({
      id: event.event_id,
      at: event.time.occurred_at ?? event.time.observed_at,
      sortBasis: event.time.sort_basis ?? (event.time.occurred_at ? 'occurred_at' : 'observed_at_fallback'),
      type: event.event_type,
      agentId: event.agent?.agent_id ?? 'git',
      agentName: event.agent?.agent_name ?? agentNames.get(event.agent?.agent_id ?? '') ?? 'Git',
      sender: eventSender(
        event,
        event.agent?.agent_name ?? agentNames.get(event.agent?.agent_id ?? '') ?? 'Git',
      ),
      deviceId: event.scanner_device_id
        ? `${event.device_id} (scanner ${event.scanner_device_id})`
        : event.device_id,
      sessionId: event.session_id,
      taskId: event.task_id,
      evidence: event.evidence.level,
      confidence: event.provenance.confidence,
      title: eventTitle(event, allowContent),
      body: eventBody(event, allowContent),
      toolName: event.activity?.tool_name,
      executionStatus: event.activity?.execution_status,
      errorMessage: event.activity?.error_message,
      commit: event.git?.commit_sha,
      branch: event.git?.branch,
      files: event.git?.changed_files,
      relationKind: event.correlation?.kind,
      relationNote: event.correlation?.note,
      matchConfidence: event.correlation?.match_confidence,
      provenance: {
        sourceType: event.provenance.source_type,
        sourcePath: event.provenance.source_path,
        sourceIdentity: event.provenance.source_path_identity,
        sourceRecordId: event.provenance.source_record_id,
        captureMethod: event.provenance.capture_method,
        captureLevel: event.provenance.capture_level,
        sourceHash: event.provenance.source_hash,
      },
      parser: {
        adapterId: event.parser.adapter_id,
        adapterVersion: event.parser.adapter_version,
        parserVersion: event.parser.parser_version,
      },
      redactionKinds: event.redaction_kinds,
      sequence: event.sequence_hint,
    }))
    .sort((a, b) => {
      if (a.at !== b.at) return a.at < b.at ? -1 : 1;
      if ((a.sequence ?? 0) !== (b.sequence ?? 0)) return (a.sequence ?? 0) - (b.sequence ?? 0);
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const sessions = [...data.sessions]
    .sort((a, b) => (b.last_seen_at ?? '').localeCompare(a.last_seen_at ?? ''))
    .map((s) => ({
      id: s.session_id,
      agent: agentNames.get(s.agent_id) ?? s.agent_id,
      device: s.device_id,
      nativeId: s.native_session_id,
      source: s.source_path,
      sourceIdentity: s.source_path_identity,
      firstSeen: s.first_seen_at,
      lastSeen: s.last_seen_at,
      eventCount: s.event_count,
      matchConfidence: s.match_confidence,
      matchBasis: s.match_basis,
      incomplete: s.incomplete,
    }));

  const agents = [...data.agents]
    .sort((a, b) => a.agent_id.localeCompare(b.agent_id))
    .map((a) => ({
      id: a.agent_id,
      name: a.agent_name,
      version: a.adapter_version,
      verification: a.verification,
      formats: a.source_format,
      capabilities: Object.fromEntries(
        Object.entries(a.capabilities ?? {}).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
      ),
    }));

  const devices = [...data.devices]
    .sort((a, b) => a.device_id.localeCompare(b.device_id))
    .map((d) => ({
      id: d.device_id,
      name: d.device_name,
      platform: d.platform,
      role: d.role,
      scannerDeviceId: d.scanner_device_id,
    }));

  const commits = [...data.commits]
    .sort((a, b) => (b.committed_at ?? '').localeCompare(a.committed_at ?? ''))
    .map((c) => ({
      sha: c.commit_sha,
      short: c.commit_sha.slice(0, 10),
      device: c.device_id,
      branch: c.branch,
      message: c.message,
      author: c.author_name,
      at: c.committed_at,
      files: c.files_changed,
      insertions: c.insertions,
      deletions: c.deletions,
      changedFiles: c.changed_files,
      parents: c.parent_shas,
    }));

  const sources = [...data.sources]
    .sort((a, b) => a.agent_id.localeCompare(b.agent_id) || a.source_path_identity.localeCompare(b.source_path_identity))
    .map((s) => ({
      id: s.source_id,
      agent: s.agent_id,
      device: s.device_id,
      path: s.source_path,
      identity: s.source_path_identity,
      type: s.source_type,
      status: s.status,
      records: s.record_count,
      malformed: s.malformed_records,
      bytes: s.size_bytes,
      modifiedAt: s.modified_at,
      reason: s.reason,
      sha256: s.sha256,
    }));

  return {
    meta: {
      title: options.title ?? `${manifest.project_name} — AI Coding Timeline`,
      projectId: manifest.project_id,
      projectName: manifest.project_name,
      identityBasis: manifest.project_identity_basis,
      identityStrong: manifest.project_identity_strong,
      operation: manifest.operation,
      timelineId: manifest.timeline_id,
      contentMode: manifest.content_mode,
      schemaVersion: manifest.schema_version,
      formatVersion: manifest.format_version,
      createdAt: manifest.created_at,
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      sourceDevices: manifest.source_devices,
      counts: {
        events: data.events.length,
        sessions: data.sessions.length,
        agents: data.agents.length,
        devices: data.devices.length,
        commits: data.commits.length,
        pushes: data.pushes.length,
        tasks: data.tasks.length,
        sources: data.sources.length,
        conflicts: data.conflicts.length,
      },
    },
    events,
    sessions,
    agents,
    devices,
    commits,
    sources,
    reports: {
      scan: data.scanReport,
      merge: data.mergeReport,
      conflicts: data.conflicts.map((c) => ({
        dedupKey: c.dedup_key,
        kept: c.kept_event_id,
        variant: c.variant_event_id,
        reason: c.reason,
        inputs: c.input_timeline_ids,
      })),
    },
    warnings,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const VIEWER_CSS = `
:root{color-scheme:light dark;--bg:#0f1115;--panel:#171a21;--panel-2:#1e222b;--border:#2a3040;--text:#e8ecf4;--muted:#97a1b5;--accent:#5aa9ff;--ok:#4ec9a0;--warn:#e0b341;--bad:#e26d6d;--chip:#232936}
@media (prefers-color-scheme:light){:root{--bg:#f6f7fa;--panel:#fff;--panel-2:#f0f2f7;--border:#dde2ec;--text:#1a2030;--muted:#5b6577;--accent:#1f6feb;--ok:#177d5b;--warn:#8a6110;--bad:#b43030;--chip:#eef1f7}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif}
header{padding:20px 24px;border-bottom:1px solid var(--border);background:var(--panel);position:sticky;top:0;z-index:5}
h1{margin:0 0 4px;font-size:20px;font-weight:650}
h2{font-size:15px;margin:0 0 10px;font-weight:650}
.sub{color:var(--muted);font-size:12.5px;display:flex;gap:14px;flex-wrap:wrap;align-items:center}
main{padding:18px 24px 60px;max-width:1380px;margin:0 auto}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:16px 0}
.kpi{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:10px 12px}
.kpi b{font-size:20px;display:block}
.kpi span{color:var(--muted);font-size:11.5px;text-transform:uppercase;letter-spacing:.04em}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:10px;margin-bottom:14px;position:sticky;top:88px;z-index:4}
input[type=search],select,button{font:inherit;color:var(--text);background:var(--panel-2);border:1px solid var(--border);border-radius:7px;padding:6px 9px}
input[type=search]{min-width:260px;flex:1}
button{cursor:pointer}
button:hover{border-color:var(--accent)}
.chip{display:inline-block;padding:1px 7px;border-radius:999px;background:var(--chip);border:1px solid var(--border);font-size:11.5px;color:var(--muted);white-space:nowrap}
.chip.verified{color:var(--ok);border-color:var(--ok)}
.chip.observed{color:var(--accent);border-color:var(--accent)}
.chip.inferred{color:var(--warn);border-color:var(--warn)}
.chip.unknown,.chip.agent_reported{color:var(--bad);border-color:var(--bad)}
.chip.strong{color:var(--ok);border-color:var(--ok)}
.chip.weak{color:var(--warn);border-color:var(--warn)}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:16px;align-items:start}
@media (max-width:1040px){.layout{grid-template-columns:1fr}.detail{position:static!important;max-height:none!important}}
.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:14px}
.day{margin:18px 0 8px;color:var(--muted);font-size:12px;font-weight:650;letter-spacing:.05em;text-transform:uppercase}
.event{display:grid;grid-template-columns:78px 1fr;gap:12px;padding:9px 10px;border:1px solid transparent;border-radius:8px;cursor:pointer}
.event:hover{background:var(--panel);border-color:var(--border)}
.event.active{background:var(--panel);border-color:var(--accent)}
.event .time{color:var(--muted);font-variant-numeric:tabular-nums;font-size:12px;padding-top:2px}
.event .title{font-weight:560;overflow-wrap:anywhere}
.meta{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;align-items:center}
.detail{position:sticky;top:150px;max-height:calc(100vh - 170px);overflow:auto}
.detail dl{display:grid;grid-template-columns:110px 1fr;gap:4px 10px;margin:0;font-size:12.5px}
.detail dt{color:var(--muted)}
.detail dd{margin:0;overflow-wrap:anywhere}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--panel-2);border:1px solid var(--border);border-radius:8px;padding:8px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;max-height:320px;overflow:auto;margin:8px 0 0}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.03em}
td.mono,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.warnlist{margin:0;padding-left:18px;color:var(--warn)}
.muted{color:var(--muted)}
.empty{color:var(--muted);padding:24px;text-align:center}
footer{color:var(--muted);font-size:11.5px;padding:0 24px 30px;max-width:1380px;margin:0 auto}
`;

const VIEWER_JS = `
(function(){
  "use strict";
  var raw=document.getElementById("timeline-data");
  var data=JSON.parse(raw.textContent);
  var state={q:"",agent:"",device:"",type:"",evidence:"",session:"",onlyGit:false,selected:null,limit:300};
  var PAGE=300;
  var $=function(id){return document.getElementById(id);};
  function el(tag,cls,text){var n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=String(text);return n;}
  function fmtTime(iso){var d=new Date(iso);if(isNaN(d.getTime()))return iso;return d.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false});}
  function fmtDay(iso){var d=new Date(iso);if(isNaN(d.getTime()))return iso.slice(0,10);return d.toLocaleDateString([], {year:"numeric",month:"short",day:"numeric",weekday:"short"});}
  function chip(text,cls){return el("span","chip "+(cls||""),text);}

  function fillSelect(id,values,label){
    var s=$(id);
    values.forEach(function(v){var o=document.createElement("option");o.value=v.value;o.textContent=v.label;s.appendChild(o);});
    s.setAttribute("aria-label",label||id);
  }
  var agents={},devices={},types={},sessions={};
  data.events.forEach(function(e){agents[e.agentId]=e.agentName||e.agentId;devices[e.deviceId]=1;types[e.type]=1;if(e.sessionId)sessions[e.sessionId]=1;});
  fillSelect("f-agent",Object.keys(agents).sort().map(function(k){return {value:k,label:agents[k]};}),"agent");
  fillSelect("f-device",Object.keys(devices).sort().map(function(k){return {value:k,label:k};}),"device");
  fillSelect("f-type",Object.keys(types).sort().map(function(k){return {value:k,label:k};}),"event type");
  fillSelect("f-session",Object.keys(sessions).sort().map(function(k){return {value:k,label:k};}),"session");
  var byId={};data.events.forEach(function(e){byId[e.id]=e;});

  function matches(e){
    if(state.agent&&e.agentId!==state.agent)return false;
    if(state.device&&e.deviceId!==state.device)return false;
    if(state.type&&e.type!==state.type)return false;
    if(state.evidence&&e.evidence!==state.evidence)return false;
    if(state.session&&e.sessionId!==state.session)return false;
    if(state.onlyGit&&!e.commit)return false;
    if(state.q){
      var q=state.q.toLowerCase();
      var hay=[e.title,e.body,e.type,e.agentName,e.deviceId,e.sessionId,e.commit,e.branch,e.provenance.sourcePath,e.provenance.sourceRecordId,(e.files||[]).join(" ")].join(" ").toLowerCase();
      if(hay.indexOf(q)===-1)return false;
    }
    return true;
  }

  function renderTimeline(){
    var host=$("timeline");host.textContent="";
    var visible=data.events.filter(matches);
    $("shown").textContent=visible.length;
    if(!visible.length){host.appendChild(el("div","empty","No events match the current filters."));return;}
    var page=visible.slice(0,state.limit);
    var day="";
    page.forEach(function(e){
      var d=fmtDay(e.at);
      if(d!==day){day=d;host.appendChild(el("div","day",d));}
      var row=el("div","event"+(state.selected===e.id?" active":""));
      row.setAttribute("role","button");
      row.setAttribute("tabindex","0");
      row.appendChild(el("div","time",fmtTime(e.at)));
      var body=el("div");
      body.appendChild(el("div","title",e.title));
      var meta=el("div","meta");
      meta.appendChild(chip(e.type));
      meta.appendChild(chip(e.agentName,"observed"));
      meta.appendChild(chip(e.evidence,e.evidence));
      if(e.commit)meta.appendChild(chip("commit "+e.commit.slice(0,10),"verified"));
      body.appendChild(meta);
      row.appendChild(body);
      row.addEventListener("click",function(){select(e.id);});
      row.addEventListener("keydown",function(ev){if(ev.key==="Enter"||ev.key===" "){ev.preventDefault();select(e.id);}});
      host.appendChild(row);
    });
    if(visible.length>page.length){
      var more=el("button",null,"Show more ("+(visible.length-page.length)+" remaining)");
      more.addEventListener("click",function(){state.limit+=PAGE;renderTimeline();});
      host.appendChild(more);
    }
  }

  function row(dl,label,value){
    if(value==null||value==="")return;
    dl.appendChild(el("dt",null,label));
    dl.appendChild(el("dd",null,value));
  }

  function select(id){
    state.selected=id;
    var e=byId[id];
    var host=$("detail");host.textContent="";
    if(!e){host.appendChild(el("div","empty","Select an event to inspect its provenance."));renderTimeline();return;}
    host.appendChild(el("h2",null,"Event detail"));
    host.appendChild(el("div","title",e.title));
    var meta=el("div","meta");
    meta.appendChild(chip(e.type));meta.appendChild(chip(e.agentName,"observed"));meta.appendChild(chip(e.evidence,e.evidence));
    if(e.confidence)meta.appendChild(chip("confidence "+e.confidence));
    host.appendChild(meta);
    var dl=el("dl");
    row(dl,"event_id",e.id);
    row(dl,"time",e.at+" ("+e.sortBasis+")");
    row(dl,"session",e.sessionId);
    row(dl,"task",e.taskId);
    row(dl,"device",e.deviceId);
    row(dl,"tool",e.toolName);
    row(dl,"status",e.executionStatus);
    row(dl,"error",e.errorMessage);
    row(dl,"commit",e.commit);
    row(dl,"branch",e.branch);
    row(dl,"files",(e.files||[]).join(", "));
    row(dl,"correlation",e.relationKind);
    row(dl,"relation note",e.relationNote);
    row(dl,"match",e.matchConfidence);
    row(dl,"source type",e.provenance.sourceType);
    row(dl,"source file",e.provenance.sourcePath);
    row(dl,"source identity",e.provenance.sourceIdentity);
    row(dl,"source record",e.provenance.sourceRecordId);
    row(dl,"capture",e.provenance.captureMethod+" / "+e.provenance.captureLevel);
    row(dl,"source hash",e.provenance.sourceHash);
    row(dl,"parser",e.parser.adapterId+" "+e.parser.adapterVersion+" / parser "+e.parser.parserVersion);
    row(dl,"redacted",(e.redactionKinds||[]).join(", "));
    row(dl,"sequence",e.sequence);
    host.appendChild(dl);
    if(e.body){host.appendChild(el("h2",null,"Content"));host.appendChild(el("pre",null,e.body));}
    var btn=el("button",null,"Copy event JSON");
    btn.addEventListener("click",function(){
      var text=JSON.stringify(e,null,2);
      if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(function(){btn.textContent="Copied";setTimeout(function(){btn.textContent="Copy event JSON";},1200);});}
    });
    host.appendChild(btn);
    renderTimeline();
  }

  function renderSessions(){
    var body=$("sessions-body");
    data.sessions.forEach(function(s){
      var tr=document.createElement("tr");
      [s.lastSeen||"",s.agent,s.device,s.nativeId,String(s.eventCount),s.matchConfidence,s.matchBasis||"",s.source].forEach(function(v,i){
        var td=el("td",i===3||i===7?"mono":null,v);
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    if(!data.sessions.length){var tr=document.createElement("tr");var td=el("td","muted","No sessions recorded");td.colSpan=8;tr.appendChild(td);body.appendChild(tr);}
  }

  function renderCommits(){
    var body=$("commits-body");
    data.commits.forEach(function(c){
      var tr=document.createElement("tr");
      tr.appendChild(el("td","mono",c.short));
      tr.appendChild(el("td",null,c.branch||""));
      tr.appendChild(el("td",null,(c.message||"").split("\\n")[0]));
      tr.appendChild(el("td",null,c.author||""));
      tr.appendChild(el("td",null,c.at||""));
      tr.appendChild(el("td",null,[c.files!=null?c.files+" files":null,c.insertions!=null?"+"+c.insertions:null,c.deletions!=null?"-"+c.deletions:null].filter(Boolean).join(", ")));
      body.appendChild(tr);
    });
    if(!data.commits.length){var tr=document.createElement("tr");var td=el("td","muted","No Git commits recorded");td.colSpan=6;tr.appendChild(td);body.appendChild(tr);}
  }

  function renderSources(){
    var body=$("sources-body");
    data.sources.forEach(function(s){
      var tr=document.createElement("tr");
      tr.appendChild(el("td",null,s.agent));
      tr.appendChild(el("td","mono",s.identity));
      tr.appendChild(el("td",null,s.status));
      tr.appendChild(el("td",null,s.records!=null?String(s.records):""));
      tr.appendChild(el("td",null,s.malformed?String(s.malformed):""));
      tr.appendChild(el("td",null,s.reason||""));
      body.appendChild(tr);
    });
    if(!data.sources.length){var tr=document.createElement("tr");var td=el("td","muted","No sources recorded");td.colSpan=6;tr.appendChild(td);body.appendChild(tr);}
  }

  function renderAgents(){
    var body=$("agents-body");
    data.agents.forEach(function(a){
      var tr=document.createElement("tr");
      tr.appendChild(el("td",null,a.id));
      tr.appendChild(el("td",null,a.name));
      tr.appendChild(el("td",null,a.version));
      var td=document.createElement("td");td.appendChild(chip(a.verification||"unknown",a.verification||"unknown"));tr.appendChild(td);
      tr.appendChild(el("td","mono",a.formats||""));
      tr.appendChild(el("td","mono",Object.keys(a.capabilities).map(function(k){return k+"="+a.capabilities[k];}).join(" ")));
      body.appendChild(tr);
    });
  }

  function renderReports(){
    var host=$("reports");host.textContent="";
    var wrap=el("div","card");
    wrap.appendChild(el("h2",null,"Package & run reports"));
    var dl=el("dl");
    row(dl,"timeline_id",data.meta.timelineId);
    row(dl,"operation",data.meta.operation);
    row(dl,"format",data.meta.formatVersion+" / schema "+data.meta.schemaVersion);
    row(dl,"content mode",data.meta.contentMode);
    row(dl,"created",data.meta.createdAt);
    row(dl,"identity",data.meta.identityBasis+(data.meta.identityStrong?"":" (weak)"));
    row(dl,"source devices",data.meta.sourceDevices.join(", "));
    if(data.reports.scan){
      var s=data.reports.scan;
      row(dl,"scan","sources "+s.sources_scanned+"/"+s.sources_discovered+", sessions "+s.sessions_matched+"/"+s.sessions_discovered+" matched, "+s.events_extracted+" events, "+s.malformed_records+" malformed, "+s.redacted_records+" redacted");
      row(dl,"scan window",s.started_at+" → "+s.completed_at);
    }
    if(data.reports.merge){
      var m=data.reports.merge;
      row(dl,"merge",m.input_events+" in → "+m.merged_events+" out, "+m.duplicate_events+" duplicates, "+m.conflict_events+" conflicts");
      row(dl,"merge identity",m.project_identity_status);
    }
    row(dl,"devices",data.devices.map(function(d){return d.id+" ("+(d.role||"source")+")";}).join(", "));
    wrap.appendChild(dl);
    if(data.warnings.length){
      wrap.appendChild(el("h2",null,"Warnings"));
      var ul=el("ul","warnlist");data.warnings.forEach(function(w){ul.appendChild(el("li",null,w));});wrap.appendChild(ul);
    }
    if(data.reports.conflicts.length){
      wrap.appendChild(el("h2",null,"Conflicts preserved"));
      var t=document.createElement("table");
      var head=document.createElement("tr");["dedup key","kept","variant","reason","inputs"].forEach(function(h){head.appendChild(el("th",null,h));});t.appendChild(head);
      data.reports.conflicts.forEach(function(c){var tr=document.createElement("tr");[c.dedupKey,c.kept,c.variant,c.reason,c.inputs.join(", ")].forEach(function(v){tr.appendChild(el("td",null,v));});t.appendChild(tr);});
      wrap.appendChild(t);
    }
    host.appendChild(wrap);
  }

  ["q","agent","device","type","evidence","session"].forEach(function(k){
    var id=k==="q"?"q":("f-"+k);
    var node=$(id);
    node.addEventListener(id==="q"?"input":"change",function(){
      var key=k==="q"?"q":k;
      state[key]=node.value;
      state.limit=PAGE;
      renderTimeline();
    });
  });
  $("f-only-git").addEventListener("change",function(){state.onlyGit=this.checked;state.limit=PAGE;renderTimeline();});
  $("reset").addEventListener("click",function(){
    state={q:"",agent:"",device:"",type:"",evidence:"",session:"",onlyGit:false,selected:state.selected,limit:PAGE};
    $("q").value="";["f-agent","f-device","f-type","f-evidence","f-session"].forEach(function(id){$(id).value="";});
    $("f-only-git").checked=false;renderTimeline();
  });
  renderTimeline();renderSessions();renderCommits();renderSources();renderAgents();renderReports();
  if(data.events.length)select(data.events[data.events.length-1].id);
})();
`;

/** Render a fully self-contained HTML document (no network, no server, no external assets). */
export function renderTimelineHtml(data: TimelineData, options: ViewerOptions = {}): string {
  const model = buildViewerModel(data, options);
  const m = model.meta;
  const title = escapeHtml(m.title);
  const counts = [
    ['events', m.counts.events],
    ['sessions', m.counts.sessions],
    ['agents', m.counts.agents],
    ['commits', m.counts.commits],
    ['push records', m.counts.pushes],
    ['devices', m.counts.devices],
    ['sources', m.counts.sources],
  ] as const;
  const kpis = counts
    .map(([label, value]) => `<div class="kpi"><b>${value}</b><span>${label}</span></div>`)
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${title}</title>
<style>${VIEWER_CSS}</style>
</head>
<body>
<header>
  <h1>${escapeHtml(m.projectName)}</h1>
  <div class="sub">
    <span class="chip ${m.identityStrong ? 'strong' : 'weak'}">identity ${escapeHtml(m.identityBasis)}${m.identityStrong ? '' : ' · weak'}</span>
    <span>project <code>${escapeHtml(m.projectId)}</code></span>
    <span>${escapeHtml(m.operation)} · ${escapeHtml(m.contentMode)}</span>
    <span>schema ${escapeHtml(m.schemaVersion)}</span>
    <span>generated ${escapeHtml(m.generatedAt)}</span>
  </div>
</header>
<main>
  <div class="kpis">${kpis}</div>
  <div class="toolbar">
    <input id="q" type="search" placeholder="Search events, commits, source paths…" aria-label="Search">
    <select id="f-agent"><option value="">All agents</option></select>
    <select id="f-device"><option value="">All devices</option></select>
    <select id="f-type"><option value="">All event types</option></select>
    <select id="f-evidence"><option value="">All evidence levels</option><option>verified</option><option>agent_reported</option><option>inferred</option><option>unknown</option></select>
    <select id="f-session"><option value="">All sessions</option></select>
    <label class="muted"><input id="f-only-git" type="checkbox"> git-linked only</label>
    <button id="reset" type="button">Reset</button>
    <span class="muted">shown <b id="shown">0</b> / ${m.counts.events}</span>
  </div>
  <div class="layout">
    <section>
      <div class="card"><h2>Unified timeline</h2><div id="timeline"></div></div>
      <div class="card"><h2>Sessions</h2>
        <table><thead><tr><th>last seen</th><th>agent</th><th>device</th><th>native id</th><th>events</th><th>match</th><th>basis</th><th>source</th></tr></thead><tbody id="sessions-body"></tbody></table>
      </div>
      <div class="card"><h2>Git commits</h2>
        <table><thead><tr><th>sha</th><th>branch</th><th>message</th><th>author</th><th>committed</th><th>diff</th></tr></thead><tbody id="commits-body"></tbody></table>
      </div>
      <div class="card"><h2>Sources</h2>
        <table><thead><tr><th>agent</th><th>identity</th><th>status</th><th>records</th><th>malformed</th><th>reason</th></tr></thead><tbody id="sources-body"></tbody></table>
      </div>
      <div class="card"><h2>Adapters &amp; verification</h2>
        <table><thead><tr><th>id</th><th>name</th><th>version</th><th>verification</th><th>format</th><th>capabilities</th></tr></thead><tbody id="agents-body"></tbody></table>
      </div>
    </section>
    <aside class="card detail" id="detail"><div class="empty">Select an event to inspect its provenance.</div></aside>
  </div>
  <div id="reports"></div>
</main>
<footer>
  Read-only snapshot of a Timeline Package. Evidence levels are preserved from the source; inferred correlations are labeled and never rendered as verified facts.
</footer>
<script type="application/json" id="timeline-data">${jsonForScript(model)}</script>
<script>${VIEWER_JS}</script>
</body>
</html>
`;
}
