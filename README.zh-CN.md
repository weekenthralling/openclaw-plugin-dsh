# openclaw-plugin-dsh

<div align="center">

**给 OpenClaw 换上一颗 DeepSeek Harness 的大脑——只需要一个模型引用。**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-2026.10.5-222222)](https://docs.openclaw.ai)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek_Harness-0.2.0--rc.2-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![作者](https://img.shields.io/badge/完全由-DeepSeek_V4_Pro-8A2BE2)](https://api-docs.deepseek.com)

> **本插件完全由 DeepSeek V4 Pro 编写** —— 每一行代码都出自一个运行在
> `deepseek-v4-pro` 上的 DeepSeek Harness agent。

</div>

## 它做什么

`openclaw-plugin-dsh` 把 OpenClaw 内部的回合执行器替换为**内嵌的 DeepSeek
Harness(DSH)agent**。当会话路由到 `dsh/...` 模型引用,或把某个已有的
provider/model 条目钉到 `dsh` 运行时,你的消息不再走 OpenClaw 的模型传输层,
而是交给一个**同进程内**的 DSH Agent,底下是完整的 DeepSeek Harness 技术栈:

- 钉到具体模型时,模型路由直接镜像 OpenClaw 准备好的这次 attempt;使用
  `dsh/...` 引用时,则采用 DSH 自己的选择(你的 `settings.yaml`);
- 自己的工具——bash、文件搜索、编辑、子 agent、workflow、goal、联网搜索
  等等;
- 自己的会话持久化与上下文压缩;
- 流式增量直接桥接回 OpenClaw 的回复管线。

OpenClaw 继续做它擅长的事——渠道、路由、会话、可见的聊天记录——而 DSH
拥有整个 agent 循环。这正是 OpenClaw 给自家 Codex harness 做的分工,现在
对 DeepSeek Harness 同样成立。

## 为什么选它

| | |
| --- | --- |
| ⚡ **零延迟交接** | 没有子进程、没有 HTTP、没有 websocket。DSH host 在同进程内启动,每个回合即时开始。 |
| 🧠 **真 agent,不是一次模型调用** | DSH 在一个回合内规划、执行工具、压缩上下文、派生子 agent、跟踪目标。 |
| 🔁 **会话不断线** | DSH 会话持久化到 `$DSH_HOME/sessions`,网关重启后自动恢复。 |
| 🛠️ **沿用你的 DSH 配置** | 模型、凭据、技能全部来自你已经在用的 DeepSeek Harness,凭据零重复。 |
| 🧯 **失败得像个大人** | 中止、超时、凭据错误都会干净地变成 OpenClaw 运行失败——带着真实的 DSH 错误信息。 |
| 📦 **一个依赖块搞定** | 全部经 npm 安装:`@deepseek-ai/dsh-*` 纯 JS 包,无原生编译。 |

## 快速开始

```bash
# 1. 安装(推荐:从 ClawHub 安装;源码安装需先 npm install && npm run build)
openclaw plugins install clawhub:openclaw-deepseek-harness
openclaw plugins install <本仓库路径>   # 源码安装

# 2. 让 agent 指向 harness
openclaw config set agents.defaults.model "dsh/deepseek-v4-pro"

# 3. 直接对话
openclaw agent --local --agent main --message "你好,DeepSeek Harness"
```

就这么简单。`dsh/<任意模型名>` 都能解析——真正的模型由 DeepSeek Harness
自己决定(它的 `agent-default-model` 路由),你永远不用维护第二份模型目录。

想继续使用 `openclaw.json` 里已经配好的 provider/model 条目?把该条目钉到
`dsh` 运行时即可(下面的方式 B)。插件会把 OpenClaw 准备好的 provider、
model、base URL、请求头与鉴权镜像进内嵌 host,于是每个回合都严格走
OpenClaw 解析出的那条路由(包括模型 fallback),并复用 OpenClaw 已有的凭据。

## 工作原理

```
OpenClaw 网关进程
┌───────────────────────────────────────────────────────────────┐
│  渠道 / 会话 / 路由 / 聊天记录                    (OpenClaw)   │
│                        │                                       │
│                        ▼  准备好的回合                         │
│   ┌─────────────────────────────────────────────┐             │
│   │      dsh agent harness(本插件)              │             │
│   │  supports() · runAttempt() · reset()        │             │
│   └───────────────────────┬─────────────────────┘             │
│                           │                                    │
│   ┌───────────────────────▼─────────────────────┐             │
│   │        内嵌的 DeepSeek Harness host         │             │
│   │  dsh-base bundle · 模型路由 · 沙箱          │             │
│   │   ┌─────────┐  ┌─────────┐  ┌────────────┐  │             │
│   │   │ Agent A │  │ Agent B │  │ Agent …    │  │             │
│   │   │ 会话    │  │ 会话    │  │            │  │             │
│   │   └─────────┘  └─────────┘  └────────────┘  │             │
│   └───────────────────────┬─────────────────────┘             │
│                           │ agent/assistant-stream 帧         │
│                           │ + session/event 持久化事件        │
│   流式增量 · 推理 · 工具结果 ─────────────────────────────────▶ │
│                          回复管线                              │
└───────────────────────────────────────────────────────────────┘
```

1. **只启动一次。** 首次认领回合时,插件通过 `@deepseek-ai/dsh-app-boot`
   启动一棵 DSH 核心树(`dsh-base` profile bundle + 一小层补丁:关闭 HMR、
   设定 persona 前缀、钉住沙箱根目录)。如果这次 attempt 带着具体的
   OpenClaw provider,补丁层还会根据 `models.providers` 声明 `llm-pi-ai`
   路由;解析出的密钥会冻结进 DSH 的 launch-environment 快照,而不会导出给
   工具派生的子进程。
2. **每个 OpenClaw 会话一个 Agent。** 每个 OpenClaw 会话映射到一个稳定的
   DSH 会话 id(`oc-<session-id>`)。首次使用创建 Agent;之后的网关进程用
   `sessionPersistence.stat` 检测持久化日志并恢复。
3. **桥接回合。** 用户输入经 `agent.followup(...)` 进入;实时
   `agent/assistant-stream` 帧把 `text-delta` 增量映射到
   `onPartialReply`、`reasoning-delta` 映射到 `onReasoningStream`,作用域内
   的 `session/event` 持久化事件提供组装好的 `assistant/message`(带
   usage)、`tool/call`、`tool/result` 与 `turn/start`/`turn/end`。
4. **全程可逆。** 中止信号与回合超时会取消 DSH agent;回合结束前
   `sessions.flush` 持久化;`/new` 销毁该会话的 Agent;插件卸载时整个
   host 一并释放。

## 配置

所有字段均可选,位于 `openclaw.json` 的 `plugins.entries.dsh.config`:

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `dshHome` | `~/.dsh` | `$DSH_HOME`:settings、凭据与会话持久化的根目录 |
| `mirrorOpenClawModel` | `true` | 把本次 attempt 的 OpenClaw provider/model/鉴权镜像进内嵌 host;设为 `false` 则沿用 DSH 自己的选择 |
| `modelProvider` | DSH 自选 | `dsh/<模型名>` 引用的模型路由覆盖(attempt 带具体 OpenClaw provider 时不生效) |
| `model` | DSH 自选 | `dsh/<模型名>` 引用的模型 id 覆盖(与 `modelProvider` 搭配) |
| `workspaceRoot` | `$HOME` | DSH 沙箱视为 workspace-write 的文件系统根 |
| `persona` | 内置 persona | 内嵌 agent 的系统提示词人设前缀 |
| `turnTimeoutMs` | `900000` | 单个内嵌 DSH 回合的安全上限(毫秒) |

```json5
{
  plugins: {
    entries: {
      dsh: {
        config: {
          modelProvider: "deepseek-official",
          model: "deepseek-v4-pro",
          workspaceRoot: "/Users/me/projects",
        },
      },
    },
  },
}
```

默认 `mirrorOpenClawModel: true` 时,钉到具体 OpenClaw 模型的 agent 会忽略
`modelProvider`/`model`——OpenClaw 准备好的路由永远优先。这两个覆盖只对
`dsh/<模型名>` 引用生效。设成 `mirrorOpenClawModel: false` 可退出镜像,
让 DSH 在所有情况下自行选择。

## 激活方式

```json5
// 方式 A:直接使用 dsh 模型引用(推荐)——任意 dsh/<模型名> 均可解析
{ agents: { defaults: { model: "dsh/deepseek-v4-pro" } } }

// 方式 B:把 harness 钉在某个已有模型条目上
{
  agents: {
    defaults: {
      model: "openai/gpt-5.5",
      models: { "openai/gpt-5.5": { agentRuntime: { id: "dsh" } } },
    },
  },
}
```

## 实测验证

在 `openclaw` **2026.10.5** + `@deepseek-ai/dsh-*` **0.2.0-rc.2** 上实测
(针对真实内嵌 host 的冒烟验证;`dsh/<模型名>` 回合使用 DSH 凭据,
而钉到 OpenClaw 模型的路由复用 OpenClaw 自己的鉴权):

| 场景 | 结果 |
| --- | --- |
| 内嵌 DSH host 启动 | ✅ dsh-base 树同进程启动;`agents`/`sessions`/`agentDefaultModel`/`sessionPersistence` 全部就位 |
| Agent 创建与驱动接口 | ✅ 运行时接口具备 `followup`/`whenIdle`/`cancel`;默认模型从 `agent-default-model` 解析 |
| 会话持久化与恢复 | ✅ `flush` → `stat` 往返;二次打开恢复持久化会话 |
| 事件桥接 | ✅ `agent/assistant-stream` 帧与 `session/event` 持久化事件均到达桥接层 |
| OpenClaw 模型镜像 | ✅ 钉到 `openclaw.json` 中 provider/model 的 agent 回复 `pong`;执行轨迹把该 provider/model 记录为实际胜出者,并使用 OpenClaw 的 auth profile |
| 凭据缺失 | ✅ 真实 DSH 错误(`MISSING_CREDENTIAL`)以结构化回合失败呈现,供 OpenClaw 上报 |
| 插件加载 | ✅ `openclaw plugins inspect dsh` → loaded |

## 故障排查

| 症状 | 处理 |
| --- | --- |
| `no API key for provider route ...` | 配置 DSH 凭据(在 DSH web 的 Models 页写入 `~/.dsh/.credentials.yaml`)或在网关环境中导出 `DEEPSEEK_API_KEY` |
| `Plugin dsh was reloaded or disabled; use its current tools.` 每 60 秒重复 | 网关热替换插件失败(重载/回滚没能重新发布模型运行时)。重启网关;请在网关空闲时安装或重载插件 |
| `plugins.allow` 警告 | 在 `openclaw.json` 中把 `"dsh"` 加入 `plugins.allow` |
| 没反应 / 想看细节 | 用 `OPENCLAW_DSH_DEBUG=1` 启动网关 |

## 已知限制

- OpenClaw 对第三方插件的 agent-harness 接口仍标注为 experimental;本插件
  锁定在上表实测的版本组合。
- OpenClaw 自己的工具与自定义指令不会流入 DSH agent——DSH 用自己的工具
  生态与 persona(`extraSystemPrompt` 会以注入上下文的方式桥接)。
- 每个网关进程只内嵌一个 host,因此 `workspaceRoot` 是全局的;各会话的
  工作目录仍跟随 OpenClaw 会话。
- 在这种内嵌场景下,DSH 的审批提示没有交互式应答方,沙箱提权默认
  fail-closed;无人值守的网关可设 `DSH_PERMISSION_MODE=danger-full-access`。

### 0.3.0 移除的功能(DSH 0.2.0 核心已删除其底座)

0.1.x 时代的 `agentPreset`(standard/code/cordis/minimal)与
`allowDynamicPlugins`(动态 Cordis 插件运行时)已移除:DSH 0.2.0 核心彻底
删掉了 agent-presets 服务,其 plugin-manager 工具集又依赖内嵌 host 没有的
profile 上下文。现在 `dsh-base` bundle 会把完整工具集装给每个内嵌 agent。
如果你依赖这两个功能,请继续使用插件 0.2.0 + DSH 0.1.0-rc.6。

## 路线图

- [x] ClawHub 分发(`clawhub:openclaw-deepseek-harness`)
- [x] OpenClaw 2026.10.5 + DSH 0.2.0-rc.2
- [ ] 把 OpenClaw 工作区文件映射进 DSH agent 的引导上下文
- [ ] 通过受限的工具行把 OpenClaw 工具桥接进 DSH
- [ ] 审批流程接入 OpenClaw 的审核 UI
- [ ] npm / ClawHub 分发

## 许可证

MIT —— 见 [LICENSE](LICENSE)。DeepSeek Harness 相关包均为 MIT 许可
([deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness))。

**英文文档**: [README](README.md)
