# aitimeline — Multi-Agent Coding Activity Timeline

[English](#english) · [中文](#中文)

`aitimeline` is a local-first, read-only CLI that reconstructs a unified, verifiable
development timeline for one project across AI coding agents, devices and Git history.
It ships as `@zhyr/ai-coding-timeline` and installs the `aitimeline` executable.

Source: <https://github.com/zhyr/multi-agent-coding-timeline>

---

# English

## What it answers

- What did I ask each agent, and what did the agent claim it did?
- Which tool calls and execution statuses are observable, and which are only agent-reported?
- Which Git commits and pushes are verified, and how do they relate to agent sessions?
- What happened on another machine if I bring back its agent data and its Timeline Package?

Everything is a snapshot produced by a manual command. There is no hook installation,
no background daemon, no watcher and no network access. Source records and Git
repositories are only ever read.

## Requirements

- Node.js **>= 22.5** (uses `node:sqlite` read-only access for Cursor metadata)
- Git on `PATH` (optional; a project without Git is still scannable)
- macOS, Linux or Windows; paths are normalized per platform

## Install from source

```bash
npm ci
npm run build
node bin/aitimeline.mjs --help
# optional: put `aitimeline` on PATH
npm link
```

## Quick start

### 1. Local scan (Mode A)

```bash
aitimeline scan \
  --project ~/work/my-project \
  --output ~/work/timeline.my-project \
  --content-mode summary
```

Reads agent data from well-known local locations (for example `~/.codex`, `~/.cursor`,
`~/.qoder`, `~/.trae`, `~/.workbuddy`) and the project's Git history. Only sessions whose
project evidence matches the target project are included; weaker matches are reported as
`candidate` and excluded by default.

### 2. Remote source scan (Mode B)

Copy or mount another device's agent data, then:

```bash
aitimeline scan \
  --project /mnt/laptop/work/my-project \
  --source-root /mnt/laptop/Users/alice \
  --source-device alice-laptop \
  --output ./from-alice.ai-timeline
```

`--source-device` is mandatory: the scanner hostname is never used as the source device
identity. Source files are read only, never modified or copied into the package.

### 3. Merge (Mode C)

```bash
aitimeline merge ./from-alice.ai-timeline ./from-bob.ai-timeline \
  --output ./unified.ai-timeline --force
```

Inputs must share the same strong project identity. Name-derived identities are rejected
unless `--allow-weak-identity` is passed after manual confirmation.

### 4. Validate and inspect

```bash
aitimeline validate ./unified.ai-timeline
aitimeline inspect ./unified.ai-timeline --events 10
aitimeline report ./unified.ai-timeline
```

### 5. Render an offline viewer

```bash
aitimeline viewer ./unified.ai-timeline --output ./timeline.html
open ./timeline.html
```

One self-contained HTML file: search and filters by agent, device, event type, evidence and
session; a provenance panel for every event; sessions, commits, sources, adapter
verification, scan/merge warnings and preserved conflicts. No network requests, no server.

## Commands

| Command | Purpose |
| --- | --- |
| `scan` | Build a device-level Timeline Package from agent records + Git |
| `merge` | Combine validated packages from multiple devices |
| `validate` | Check schema, references and SHA-256 integrity |
| `inspect` | Human/JSON summary of a package |
| `report` | Print the stored scan or merge report |
| `viewer` | Render a package to one offline HTML file |
| `adapters` | Show the honest adapter capability matrix |
| `version` | Show CLI, format, schema and runtime versions |

Full options and exit codes: [docs/cli-reference.md](docs/cli-reference.md).

## Timeline Package

```
manifest.json
project.json
devices.json
agents.json
sessions.jsonl
tasks.jsonl
events.jsonl
relations.jsonl
git/commits.jsonl
git/pushes.jsonl
sources/source-index.jsonl
sources/scan-inputs.json        # present for scans
reports/scan-report.json        # present for scans
reports/merge-report.json       # present for merges
reports/conflicts.jsonl
integrity/checksums.sha256
```

`integrity/checksums.sha256` covers every generated file except itself. `validate` fails on
any content change. See [docs/timeline-schema.md](docs/timeline-schema.md).

## Evidence, not assumptions

Every event carries `evidence.level` — `verified`, `agent_reported`, `inferred` or
`unknown` — plus `provenance` and the parser version.

- Git commits and pushes backed by real refs are `verified`.
- "Task complete" messages from an agent are `agent_reported`, never upgraded.
- WorkBuddy session starts, Trae memory summaries and Cursor transcript ordering are
  explicitly `inferred`/`agent_reported`, with notes.
- Candidate project matches are excluded by default and labelled when included.
- Conflicting versions of the same source record are never discarded; both are kept and
  recorded in `reports/conflicts.jsonl`.

## Adapter status (verified 2026-11-17 on this machine)

| Adapter | Verification | Sessions seen | Notes |
| --- | --- | --- | --- |
| `codex` | verified | 214 | JSONL + zstd, `session_meta.payload.cwd`, tool calls partial |
| `cursor` | partially verified | 2,528 | transcripts have no timestamps; SQLite metadata read-only |
| `qoder` | verified | 4 | cwd/gitBranch/timestamps/tool blocks |
| `trae` | partially verified | 1 | memory summaries only; all events agent-reported |
| `workbuddy` | partially verified | 7 | security audit events, no conversation transcripts |
| `claude-code` | not testable | 0 | no local `~/.claude/projects`; synthetic fixtures only |
| `codebuddy` | discovery only | 0 | directory observed, no verified session format |
| `zcode` | not testable | 0 | no local installation |
| `opencode` | partially verified | 1 | `project/session/message/part` JSON; text parts only, no tool parts observed |

Details and per-field capability levels: [docs/agent-adapters.md](docs/agent-adapters.md).

## Documentation

- [Product design](docs/product-design.md)
- [Architecture](docs/architecture.md)
- [Timeline schema](docs/timeline-schema.md)
- [Agent adapters](docs/agent-adapters.md)
- [Project resolution](docs/project-resolution.md)
- [Remote scanning](docs/remote-scanning.md)
- [Timeline merging](docs/timeline-merging.md)
- [Security and privacy](docs/security-and-privacy.md)
- [CLI reference](docs/cli-reference.md)
- [Testing and verification](docs/testing-and-verification.md)
- [Release notes](docs/release-notes.md)
- [Product specification](docs/AI%20Coding%20Timeline%20Scanner.md)

## Development

```bash
npm run typecheck   # strict TypeScript
npm test            # vitest (unit + integration + CLI end-to-end)
npm run build       # emit dist/
npm run verify      # typecheck + tests + build
```

Node is required for all commands. Tests use synthetic fixtures in temporary directories;
no home directory data is read during the test suite. Real-data adapter verification was
performed separately, read-only, and is documented with counts in
[docs/testing-and-verification.md](docs/testing-and-verification.md).

## Known limitations

- Agent formats are unofficial and may change without notice. A parser failure is reported
  as a source error; it never fabricates events.
- Cursor transcript records carry no timestamps, so their `occurred_at` is empty and
  sorting falls back to `observed_at`.
- Claude Code and ZCode have no locally verified parser; they are not claimed as supported.
  CodeBuddy is discovery-only. OpenCode is verified for sessions/messages/text, but its tool
  and file-change records have not been observed.
- The 3-way "A+B+C" merge is the same operation as 2-way merge: it is deterministic and
  idempotent, but Git push evidence remains per-device and is never synthesized.
- Only manual runs are supported. Incremental state stores fingerprints only; unchanged
  session files are reused from the previous package, and any change forces a full re-parse.
- Content mode `full` may include prompts and code. `metadata_only` is recommended for
  anything that leaves your machine.

---

# 中文

## 产品定位

`aitimeline` 是一个本地优先、只读的命令行工具，用于把同一个项目在多个 AI Coding Agent、
多台设备以及 Git 历史中留下的开发活动，重建为一条统一、可校验的时间线。npm 包名为
`@zhyr/ai-coding-timeline`，安装后提供 `aitimeline` 命令。

仓库地址：<https://github.com/zhyr/multi-agent-coding-timeline>

它回答这几类问题：

- 我对每个 Agent 提过什么要求？Agent 又声称自己做了什么？
- 哪些工具调用和执行状态是真实可观察的？哪些只是 Agent 自述？
- 哪些 Git 提交和推送经过验证？它们与哪些 Agent 会话相关？
- 如果把另一台设备的 Agent 数据和 Timeline 包带回来，那台机器上发生过什么？

所有产物都来自手动执行的命令快照。工具不安装 Git Hook，不常驻后台，不监听文件变化，
也不访问网络；源记录与 Git 仓库始终只读。

## 环境要求

- Node.js **>= 22.5**（读取 Cursor 元数据时使用 `node:sqlite` 的只读能力）
- `PATH` 中可用的 Git（可选；没有 Git 的项目同样可以扫描）
- macOS、Linux 或 Windows；路径按平台做归一化

## 从源码安装

```bash
npm ci
npm run build
node bin/aitimeline.mjs --help
# 可选：把 aitimeline 放进 PATH
npm link
```

## 快速开始

### 1. 本机扫描（模式 A）

```bash
aitimeline scan \
  --project ~/work/my-project \
  --output ~/work/timeline.my-project \
  --content-mode summary
```

工具会从本地常见目录读取 Agent 数据（例如 `~/.codex`、`~/.cursor`、`~/.qoder`、
`~/.trae`、`~/.workbuddy`），并读取目标项目的 Git 历史。只有项目证据能够匹配目标项目的
会话才会进入正式时间线；证据较弱的匹配会标记为 `candidate`，默认不纳入。

### 2. 跨设备源扫描（模式 B）

先把另一台设备的 Agent 数据复制或挂载到本机，然后执行：

```bash
aitimeline scan \
  --project /mnt/laptop/work/my-project \
  --source-root /mnt/laptop/Users/alice \
  --source-device alice-laptop \
  --output ./from-alice.ai-timeline
```

`--source-device` 为必填项：工具绝不会用扫描机的 hostname 推断数据所属设备。源文件只读，
不会被修改，也不会被复制进 Timeline 包。

### 3. 多设备合并（模式 C）

```bash
aitimeline merge ./from-alice.ai-timeline ./from-bob.ai-timeline \
  --output ./unified.ai-timeline --force
```

参与合并的包必须具有相同的强项目身份。仅由项目名推导出的弱身份默认会被拒绝；人工确认后
可显式传入 `--allow-weak-identity` 放行。

### 4. 校验与查看

```bash
aitimeline validate ./unified.ai-timeline
aitimeline inspect ./unified.ai-timeline --events 10
aitimeline report ./unified.ai-timeline
```

### 5. 生成离线 Viewer

```bash
aitimeline viewer ./unified.ai-timeline --output ./timeline.html
open ./timeline.html
```

输出是单个自包含 HTML 文件：支持按 Agent、设备、事件类型、证据等级和会话检索与过滤；
每个事件都有来源面板；同时展示会话、提交、数据源、适配器验证状态、扫描/合并告警，以及
被保留的冲突记录。不发起任何网络请求，也不需要启动服务。

## 命令一览

| 命令 | 用途 |
| --- | --- |
| `scan` | 从 Agent 记录 + Git 生成设备级 Timeline 包 |
| `merge` | 合并来自多台设备的、已通过校验的 Timeline 包 |
| `validate` | 校验 Schema、引用关系与 SHA-256 完整性 |
| `inspect` | 以人类可读或 JSON 形式输出包的摘要 |
| `report` | 打印包内保存的扫描报告或合并报告 |
| `viewer` | 把包渲染成一个离线 HTML 文件 |
| `adapters` | 展示真实的适配器能力矩阵 |
| `version` | 显示 CLI、格式、Schema 与运行时版本 |

完整参数与退出码见 [docs/cli-reference.md](docs/cli-reference.md)。

## Timeline 包结构

```
manifest.json
project.json
devices.json
agents.json
sessions.jsonl
tasks.jsonl
events.jsonl
relations.jsonl
git/commits.jsonl
git/pushes.jsonl
sources/source-index.jsonl
sources/scan-inputs.json        # 扫描产物中存在
reports/scan-report.json        # 扫描产物中存在
reports/merge-report.json       # 合并产物中存在
reports/conflicts.jsonl
integrity/checksums.sha256
```

`integrity/checksums.sha256` 覆盖除自身以外的所有生成文件；任何内容改动都会让
`validate` 失败。详见 [docs/timeline-schema.md](docs/timeline-schema.md)。

## 以证据为准，不做假设

每个事件都带有 `evidence.level`（`verified`、`agent_reported`、`inferred` 或 `unknown`），
并保留 `provenance` 与解析器版本。

- 有真实 ref 支撑的 Git 提交与推送标记为 `verified`。
- Agent 自称的“任务完成”一律标记为 `agent_reported`，不会被提升等级。
- WorkBuddy 的会话开始时间、Trae 的记忆摘要、Cursor 转录顺序，明确标注为
  `inferred`/`agent_reported`，并附说明。
- 仅达到候选级别的项目匹配默认排除；被纳入时会明确标注。
- 同一条源记录出现冲突版本时不会丢弃任何一方，两者都会保留并写入
  `reports/conflicts.jsonl`。

## 适配器状态（2026-11-17 在本机实测）

| 适配器 | 验证状态 | 实测会话数 | 说明 |
| --- | --- | --- | --- |
| `codex` | verified | 214 | JSONL + zstd，使用 `session_meta.payload.cwd`，工具调用为部分支持 |
| `cursor` | partially verified | 2,528 | 转录记录无时间戳；SQLite 元数据只读 |
| `qoder` | verified | 4 | 提供 cwd/gitBranch/时间戳/工具块 |
| `trae` | partially verified | 1 | 仅有记忆摘要；全部事件为 agent-reported |
| `workbuddy` | partially verified | 7 | 安全审计事件，无对话转录 |
| `claude-code` | not testable | 0 | 本机无 `~/.claude/projects`，仅用合成样本测试 |
| `codebuddy` | discovery only | 0 | 只观察到目录，未验证会话格式 |
| `zcode` | not testable | 0 | 本机未安装 |
| `opencode` | partially verified | 1 | `project/session/message/part` JSON；仅观察到 text part，未观察到工具调用 |

字段级能力等级与实现细节见 [docs/agent-adapters.md](docs/agent-adapters.md)。

## 文档

- [产品设计](docs/product-design.md)
- [架构](docs/architecture.md)
- [Timeline Schema](docs/timeline-schema.md)
- [Agent 适配器](docs/agent-adapters.md)
- [项目识别](docs/project-resolution.md)
- [远程扫描](docs/remote-scanning.md)
- [时间线合并](docs/timeline-merging.md)
- [安全与隐私](docs/security-and-privacy.md)
- [CLI 参考](docs/cli-reference.md)
- [测试与验证](docs/testing-and-verification.md)
- [发布说明](docs/release-notes.md)
- [产品规格](docs/AI%20Coding%20Timeline%20Scanner.md)

## 开发

```bash
npm run typecheck   # 严格 TypeScript 类型检查
npm test            # vitest（单元 + 集成 + CLI 端到端）
npm run build       # 输出 dist/
npm run verify      # typecheck + 测试 + 构建
```

所有命令都依赖 Node。测试只使用临时目录中的合成样本，不会读取用户主目录中的真实数据。
真实数据的适配器验证是另外单独执行的，全程只读，具体数量记录在
[docs/testing-and-verification.md](docs/testing-and-verification.md)。

## 已知限制

- Agent 的数据格式并非公开契约，可能随时变化。解析失败会作为数据源错误上报，绝不会
  凭空构造事件。
- Cursor 的转录记录没有时间戳，因此其 `occurred_at` 为空，排序时回退到 `observed_at`。
- Claude Code、ZCode 在本机没有经过验证的解析器，因此不宣称已支持；CodeBuddy 仅做到目录发现。
  OpenCode 已验证会话/消息/文本解析，但其工具调用与文件变更记录尚未观察到。
- “A+B+C” 三方合并与两方合并是同一套操作：结果确定且幂等；但 Git 推送证据始终按设备
  独立记录，不会被合成。
- 仅支持手动执行。增量状态只保存文件指纹：未变化的会话文件复用上一次包中的结果，一旦
  文件变化则重新完整解析。
- `full` 内容模式可能包含提示词和代码；任何要离开本机的包建议使用 `metadata_only`。
