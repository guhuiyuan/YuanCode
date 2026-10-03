# YuanCode

> **从零到一搭建的类 Claude Code 编程 Agent 工作台。**
> *终端就是一切。*

YuanCode 是一款开源、终端优先的编程 Agent。它读取你在 shell 里敲下的一段话,驱动大模型在「读 → 写 → 改 → 执行 → 搜索 → 派生子 Agent → 加载 SKILL」的工具循环里迭代推进,并由严格的权限闸门、自动 Checkpoint、三层上下文压缩把整轮跑得稳、收得回来。

整套系统的核心非常克制:**AgentLoop 永远不变**,所有能力(Skills / MCP / Hooks / Subagent / Sandbox)都外挂。

---

## 为什么做它

* **能真的从 0 到 1 撑住大项目。** 一个任务可以跑上几个小时,断点续传靠 session resume 接回来。
* **默认沙箱化。** 每次 `bash` 调用都过一道可配置的沙箱(local / bubblewrap / docker / landlock),默认就被禁止碰 `~/.ssh`、`/etc`、`C:\Windows\System32` 这类敏感路径。
* **靠 Checkpoint,不靠运气。** 每次改文件前先打快照,连按两次 Esc 就能回滚代码、回滚对话、或者两个一起回滚。
* **模型可热插拔。** 默认接 MiniMax M3(Anthropic 兼容协议),改一份 YAML 或跑一次 `yuancode init` 就能切到 Anthropic、OpenAI,或者任何兼容 OpenAI 协议的私有端点。

---

## 五层架构

```
┌─────────────────────────────────────────────────────────────┐
│  L1 输出层 — 终端 CLI + Ink TUI                              │
├─────────────────────────────────────────────────────────────┤
│  L2 配置层 — user → project → session 三级合并              │
├─────────────────────────────────────────────────────────────┤
│  L3 扩展层 — Yuan.md / Skills / MCP / Hooks                 │
├─────────────────────────────────────────────────────────────┤
│  L4 Harness 核心层                                           │
│  AgentLoop · ToolRegistry · PermissionGate · SessionStore   │
│  ContextCompactor · StreamingToolExecutor · CheckpointMgr   │
│  TraceLogger · CostGuard · Subagent · TaskManager · Hooks   │
├─────────────────────────────────────────────────────────────┤
│  L5 模型层 — Anthropic / OpenAI / MiniMax / 自定义 OpenAI   │
└─────────────────────────────────────────────────────────────┘
```

---

## 快速开始(clone-and-go)

需要 **Node.js ≥ 20.10** 和一个 POSIX 兼容的 shell(Linux / macOS / Windows 上的 Git Bash 都行)。

```bash
git clone https://github.com/guhuiyuan/yuancode.git
cd yuancode
./bin/setup              # Linux / macOS / Git Bash
# 或: bin\setup.cmd       # Windows cmd
```

`setup` 一次性帮你做完:

1. 校验 Node ≥ 20.10
2. 没装 pnpm 就顺手装上
3. 跑 `pnpm install`(依赖装在项目内 `node_modules/`,不会污染全局)
4. 如果没有 `.env` 就把 `.env.example` 复制过去
5. 启动 `yuancode init` 向导:挑 provider、贴 API key

向导跑完后再验证一下:

```bash
node bin/yuancode.mjs doctor   # 环境体检
node bin/yuancode.mjs          # 启动 TUI
```

### 零配置也能跑

跳过向导,直接用默认值:

* Provider:`minimax`
* Base URL:`https://api.minimaxi.com/anthropic`
* 模型:`MiniMax-M3`
* 权限模式:`acceptEdits`
* 沙箱:`local`

只要在 shell 里 `export YUANCODE_API_KEY=...` 就能直接对话。

---

## 命令一览

```text
yuancode                 启动交互式 TUI
yuancode init            首次配置向导
yuancode doctor          环境体检
yuancode resume <id>     续接上一次的会话
yuancode --help          全部选项
```

常用开关:

* `--cwd <path>` — 把操作目录切到别的项目根
* `--verbose` / `--log-level debug` — 打开 debug 日志
* `YUANCODE_API_KEY=…` — 直接传 API key

---

## 配置

配置按优先级从低到高加载:

1. 内置默认值(`src/config/defaults.ts`)
2. `~/.yuancode/config.yaml`(用户级)
3. `<cwd>/.yuancode/config.yaml`(项目级)
4. 环境变量(`YUANCODE_API_KEY`、`YUANCODE_PROVIDER` 等)

完整 schema 见 `templates/config.user.yaml.example`。最常用的几项:

```yaml
model:
  provider: minimax         # minimax | anthropic | openai | custom
  model: MiniMax-M3
  baseUrl: https://api.minimaxi.com/anthropic
  maxTokens: 8192
  cacheControl: true        # 启用 Anthropic prompt caching
permissionMode: acceptEdits # manual | acceptEdits | auto | plan
limits:
  maxSteps: 50
  totalTimeoutMs: 1800000   # 单轮总时长上限 30 分钟
  perStepTimeoutMs: 60000
  maxCostUsd: 5.0
sandbox:
  mode: local               # local | bubblewrap | docker | landlock
```

---

## 项目记忆:Yuan.md

`Yuan.md` 是项目的长期记忆,会被 YuanCode 拼进每轮 system prompt:

* `~/.yuancode/YUAN.md` — 个人偏好
* `<project>/Yuan.md` — 项目级规则(请提交到 git)
* `<project>/Yuan.local.md` — 本地覆盖(放进 `.gitignore`)

起步模板见 `templates/Yuan.md.example`。

---

## 内置工具

| 工具            | 风险  | 可并行 | 干啥用                                    |
|-----------------|-------|--------|-------------------------------------------|
| `read`          | 低    | ✅     | 读文件(支持行范围)                       |
| `write`         | 高    | ❌     | 创建 / 覆盖文件(走 Checkpoint)           |
| `edit`          | 高    | ❌     | 定点编辑(走 Checkpoint)                  |
| `bash`          | 高    | ❌     | 跑 shell 命令(走沙箱)                    |
| `grep`          | 低    | ✅     | ripgrep 内容搜索                          |
| `glob`          | 低    | ✅     | 文件路径匹配                              |
| `todowrite`     | 低    | ❌     | 计划 / 进度清单                           |
| `subagent`      | 中    | ❌     | 派生一个 fresh-context 子 Agent            |
| `skill`         | 低    | ❌     | 按需加载 SKILL.md                          |
| `task_*`        | 低    | ✅     | 任务 DAG 的 CRUD                          |
| `webfetch`      | 中    | ✅     | HTTP GET(带超时)                         |
| `background_*`  | 低    | ✅     | 启动 / 查询异步后台任务                   |

---

## Skills

Skills 放在 `skills/<name>/SKILL.md`。YuanCode 只把 skill 的名称和简介暴露在 system prompt 里,模型真要用的时候才调 `skill` 工具把正文加载回来——既给得到能力,又不浪费 token。

仓库自带三个示例:

* `code-review` — 结构化的代码审查清单
* `refactor` — 行为保持的重构流程
* `test` — 测试生成剧本

自己加一个的话,在 `skills/` 下新建目录就行。

---

## MCP(Model Context Protocol)

YuanCode 同时支持 Streamable HTTP 和 stdio 两种 MCP 传输。配置文件路径:`~/.yuancode/mcp.json` 或 `<project>/.yuancode/mcp.json`。

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" }
    }
  }
}
```

两种传输是按结构自动识别的:

- 配了 `command` → stdio(启动二进制,行分隔的 JSON-RPC)
- 配了 `url` → Streamable HTTP(POST JSON-RPC)

MCP 工具在 Agent 里以 `mcp__<server>__<tool>` 形式出现(server 名归一化为 `[a-z0-9_]+`,命名冲突时后到的被丢弃)。每个工具都注册到 `ToolRegistry`,category 标为 `'mcp'`、risk 标为 `'low'`,`PermissionGate` 里有专门给 `mcp` category 的分支,这样即使在 `plan` 模式下,中等 / 高风险的 MCP 工具也会被拦下。

MCP server 跑到一半崩了?`McpManager` 会把它标记为 crashed,下一次调用直接返回 `"mcp server \"<name>\" is unavailable (crashed or not connected)"`,而不是挂死。M6 不做自动重连,重启 session 是恢复路径。

完整样例见 `templates/mcp.example.json`(filesystem / fetch / GitHub / 一个远程 OAuth 例子)。想跑个不依赖外部依赖的端到端:

```bash
node scripts/m6-smoke.mjs
```

它会启动 `scripts/fixtures/mcp-echo-server.mjs`(130 行 stdio MCP server,自带 `echo` 和 `add` 两个工具),把 connect → list → call → dispose 全流程跑一遍。

---

## Hooks

Hooks 在 Agent 的生命周期事件上挂回调。配置路径:`~/.yuancode/hooks.yaml` 或 `<project>/.yuancode/hooks.yaml`,两份合并、项目级覆盖用户级。

| 事件               | 拦截? | 说明                                    |
|--------------------|-------|-----------------------------------------|
| `SessionStart`     | —     | 通知类,stderr/stdout 进日志             |
| `SessionEnd`       | —     | 通知类                                  |
| `UserPromptSubmit` | ✅    | deny 直接拦下这条 prompt                |
| `PreToolUse`       | ✅    | deny 拦下;approve 可让 ask 升为 allow   |
| `PostToolUse`      | —     | 通知类(审计 / 打点)                    |
| `PreCompact`       | ✅    | deny 让压缩直接短路                     |
| `PostCompact`      | —     | 通知类                                  |
| `SubagentStart`    | ✅    | deny 终止子 Agent 的派发                |
| `SubagentEnd`      | —     | 通知类                                  |
| `Notification`     | —     | 后台任务完成事件                        |

```yaml
# .yuancode/hooks.yaml
hooks:
  PreToolUse:
    - matcher: 'bash'
      type: bash
      command: |
        echo "[$(date)] $YUAN_TOOL_INPUT_JSON" >> .yuancode/logs/audit.log
        exit 0
    - matcher: 'webfetch'
      type: http
      url: 'https://hooks.example.com/pre-tool'
```

语义要点:

- `type: bash` — 跑命令,exit 0 = allow,非 0 = deny。
  `YUAN_TOOL_NAME`、`YUAN_TOOL_INPUT_JSON`、`YUAN_SESSION_ID` 三个环境变量自动注入。60 秒超时,1 MiB 输出截断。
- `type: http` — POST JSON payload 到 URL,2xx = allow,非 2xx = deny。
- **Approve 决策** — 在 stdout(bash)或 body(http)里吐 `{"decision":"approve"}`,可以让本来要 `ask` 的权限决策直接升为 `allow`。适合那些被信任的服务器 / 身份,绕开手动询问。
- **失败即拒绝(fail-closed)** — 任何错误(spawn 失败、超时、网络异常、响应畸形)都按 `deny` 处理。你的 hook 如果抽风,Agent 会停下来而不是偷偷放行。

匹配器按需懒编译。普通字符串 = 精确匹配工具名;`/regex/` 或 `^prefix` = 正则;非法的正则会在加载阶段就被拒掉,对应这条 entry 被丢弃,但文件本身仍可加载。

引擎自带深度有界的循环检测,即便 hook 通过同步回调链意外重入引擎,到深度 5 也会被截断,不会无限自旋。

`PermissionGate` 现在是一条三段管线:

1. **Mode** — `manual / acceptEdits / auto / plan` × `risk × category`
2. **Hooks** — `PreToolUse` 可以否决任何 allow,也可以把 ask 升为 allow
3. **Ask user** — 只有前两段都说 ask,才会真的问人

完整事件清单见 `templates/hooks.example.yaml`。

---

## Sandbox

每次 `bash` 调用(以及任何会 shell out 的工具)都过一层可插拔的沙箱。沙箱会清洗环境(剥掉 `*API_KEY`、`AWS_*`、`*_TOKEN` 等)、强制单次超时、给每个流 1 MiB 上限、并响应 hard-abort 信号。M7 一口气把四种模式补齐了:

| 模式         | 平台                   | 隔离强度       | 冷启动   | 说明                                  |
|--------------|------------------------|----------------|----------|---------------------------------------|
| `local`      | 全部(默认)            | 弱 — 进程 + 环境清洗 | 0 ms     | 跨平台兜底,内置禁写路径扫描会拦下 `cd /etc`、`cat ~/.ssh/id_rsa` 之类的命令。 |
| `bubblewrap` | Linux                  | 中 — user namespace + bind mount | ~50 ms   | 用 `bwrap --unshare-pid --unshare-net --die-with-parent` 包一道。 |
| `docker`     | 全部(需 daemon)       | 强 — 容器      | ~500 ms  | `docker run --rm --network none -v <cwd>:/workspace`,镜像取自 `sandbox.image`(默认 `alpine:3.19`)。 |
| `landlock`   | Linux 5.13+、Node 22+  | 强 — 内核 LSM  | ~5 ms    | 直接用 `node:landlock` 限制当前进程的 FS 访问。 |

`createSandbox()` 根据 `sandbox.mode` 派发对应的实现。在 Windows / macOS 上选 `bubblewrap` / `landlock` 会得到一条清晰的「当前平台不支持」报错——这种情况下退回到 `docker` 或 `local` 即可。每个 runner 都暴露 `healthcheck()`,TUI 启动 banner 会顺带把前置依赖的缺失(`bwrap` 没装、Docker daemon 没启、内核太老)主动标出来,而不是等第一条命令才炸。

```yaml
# config.yaml
sandbox:
  mode: docker              # local | bubblewrap | docker | landlock
  image: yuancode/sandbox   # 仅 docker 模式生效
  network: none             # none | host | bridge(仅 docker)
  memory: 512m              # 仅 docker
  cpus: 1                   # 仅 docker
```

完整的安全模型见 `docs/sandbox.md`,镜像细节见 `bin/sandbox/Dockerfile`(一个只有 Node + bash + coreutils 的极简镜像)。

---

## Trace 与可观测性

`TraceLogger`(在 `src/core/trace-logger.ts`)是一层薄薄的、基于 pino 的 span 层——不引 OpenTelemetry SDK,不加新依赖。每个有意义的操作开一个 span,每次 `endSpan` 都吐一行结构化日志,用 `traceId` 就能在海量日志里串起来。

当前覆盖到的 span:

| Span 名字          | 出处                                       | 关键 attrs                |
|--------------------|--------------------------------------------|---------------------------|
| `loop.run`         | `runAgentLoop`                             | `sessionId`、`model`      |
| `loop.iteration`   | 每一轮 LLM 迭代                            | `step`、`stopReason`      |
| `loop.llm`         | `provider.chat`                            | `model`、`usage`          |
| `tool.<name>`      | `ToolRegistry.execute`                     | `toolName`、`toolInput`   |
| `gate.decide`      | `PermissionGate.decide`                    | `tool`、`decision`        |
| `sandbox.run`      | 每次 `SandboxRunner.run`                   | `mode`、`cmd`             |
| `mcp.callTool`     | `McpConnection.callTool`                   | `server`、`tool`          |

线上日志长这样:

```text
{"traceId":"…","spanId":"…","name":"loop.llm","durMs":842,"status":"ok","model":"MiniMax-M3","usage":{"inputTokens":431,"outputTokens":120}}
```

落盘(可选):

```bash
YUANCODE_TRACE_FILE=.yuancode/trace.jsonl yuancode   # 追加 JSONL
node -e 'const t=require("./dist/core/trace-logger"); console.log(t.snapshot())'   # 进程内快照
```

两个安全阀:

- `sampleRate`(0..1) — 按概率丢 span,默认 1(全量记录)
- `maxSpans` — 内存里历史 span 的 FIFO 上限,默认 1000。线上日志**不受**这个上限影响。

---

## 成本与限额

成本按调用、按模型、按 session 三维度追踪,由 `CostGuard`(`src/core/cost-guard.ts`)负责。定价表可以自己覆盖:

```yaml
# config.yaml — 覆盖内置默认值
pricing:
  'MiniMax-M3':          { input: 0.10, output: 0.30 }
  'claude-opus-4-5':     { input: 15.0, output: 75.0 }
  'claude-sonnet-4-5':   { input: 3.0,  output: 15.0 }
  'claude-haiku-4-5':    { input: 0.80, output: 4.0  }
```

(完整起步模板见 `templates/pricing.example.yaml`。)

`limits:` 下面这四个旋钮:

| 字段                | 默认值                | 作用                                              |
|---------------------|-----------------------|---------------------------------------------------|
| `maxSteps`          | 50                    | 单 session 迭代步数硬上限                        |
| `totalTimeoutMs`    | 1 800 000(30 分钟)   | 单 session 的总墙钟上限                           |
| `perStepTimeoutMs`  | 60 000(60 秒)        | 实际是 `provider.chat({ maxTokens })` 的提示,不是墙钟计时器——双重语义见 `docs/cost-and-limits.md` |
| `maxCostUsd`        | 5.0                   | 由 CostGuard 强制执行的 USD 上限,0 = 不限         |

`CostGuard` 默认带 5% 的 grace fraction——哪怕这一步把累计花销推过 ceiling,也允许它跑完,不把模型回复拦腰截断。子 Agent 会派生自己的 child `CostGuard`,额度更紧(默认父级额度的 10%,且不超过 $0.50),这样子循环失控也炸不掉父级的预算。

花销任何时候都能查:

```bash
node -e 'const {CostGuard,DEFAULT_PRICING}=require("./dist/core/cost-guard"); const g=new CostGuard({pricing:DEFAULT_PRICING,maxCostUsd:5,model:"MiniMax-M3",sessionId:"x"}); console.log(g.breakdown())'
```

每个 limit 的精确语义和 `child()` 子作用域 API,见 `docs/cost-and-limits.md`。

---

## 开发

```bash
pnpm install            # 装依赖
pnpm test               # 单元测试
pnpm test:e2e           # E2E 测试
pnpm build              # tsc → dist/
pnpm dev                # tsx 监听模式
pnpm typecheck          # 严格 tsc --noEmit

# 里程碑 smoke demo —— 不依赖 LLM 也能跑一遍全链路
node scripts/m4-smoke.mjs   # Checkpoint + ContextCompactor + /rewind
node scripts/m5-smoke.mjs   # Subagent + TaskManager + BackgroundTaskPool
node scripts/m6-smoke.mjs   # Hooks + MCP + PermissionGate(需要先 `pnpm build`)
node scripts/m7-smoke.mjs   # Sandbox 模式 + CostGuard + TraceLogger(需要先 `pnpm build`)
```

目录结构:

```
yuancode/
├── bin/                 # yuancode.mjs 入口 + setup 脚本
├── templates/           # Yuan.md / config / hooks / mcp 示例
├── skills/              # 自带 skills(code-review, refactor, test)
├── scripts/             # 里程碑 smoke demo + MCP fixture
├── src/
│   ├── main.ts          # CLI 入口(commander)
│   ├── core/            # L4 harness(loop, registry, permissions, …)
│   ├── tools/           # 内置工具 handler
│   ├── extensions/      # L3 只读加载器(yuan-md, skills)
│   ├── hooks/           # M6 — 生命周期 hook 引擎(bash + http)
│   ├── mcp/             # M6 — MCP 客户端(stdio + Streamable HTTP)
│   ├── model/           # L5 provider adapter
│   ├── config/          # L2 schema、defaults、loader
│   ├── cli/             # init / doctor / run / resume
│   ├── tui/             # Ink UI
│   └── utils/           # logger、id、path-safety、prompt、env
└── tests/
    ├── unit/
    └── e2e/
```

---

## Roadmap

| #  | 里程碑                                              | 状态 |
|----|-----------------------------------------------------|------|
| M0 | clone-and-go 基础设施(setup / init / doctor / loader)| ✅   |
| M1 | Agent Loop + 沙箱化 `bash` + Ink TUI                | ✅   |
| M2 | 完整工具集 + Tool Registry + Permission Gate        | ✅   |
| M3 | Yuan.md + Skills + provider 适配器                  | ✅   |
| M4 | Checkpoint + 上下文压缩 + `/rewind`                  | ✅   |
| M5 | Subagent + TaskManager + 后台任务                   | ✅   |
| M6 | Hooks + MCP 客户端                                  | ✅   |
| M7 | 完整 sandbox 模式 + trace + cost + 测试 + 文档     | ✅   |

每个里程碑的详细设计稿见 [docs/](docs/)。

---

## 致谢

YuanCode 在设计和实现上参考了大量前人工作:

* [shareAI-lab/learn-claude-code](https://github.com/shareAI-lab/learn-claude-code) — 12 节渐进式教学仓库
* [Anthropic Claude Code](https://claude.com/claude-code) — Checkpoint、权限、Subagent 等生产级模式
* [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — "everything is a plugin" 的哲学(我们做了收敛)

---

## 许可

MIT — 见 [LICENSE](LICENSE)。