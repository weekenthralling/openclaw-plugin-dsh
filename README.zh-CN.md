# openclaw-plugin-dsh

<div align="center">

**给 OpenClaw 换上一颗 DeepSeek Harness 的大脑——只需要一个模型引用。**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-2026.7.1--2-222222)](https://docs.openclaw.ai)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek_Harness-0.1.0--rc.6-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![作者](https://img.shields.io/badge/完全由-DeepSeek_V4_Pro-8A2BE2)](https://api-docs.deepseek.com)

> **本插件完全由 DeepSeek V4 Pro 编写** —— 每一行代码都出自一个运行在
> `deepseek-v4-pro` 上的 DeepSeek Harness agent。

</div>

## 它做什么

`openclaw-plugin-dsh` 把 OpenClaw 内部的回合执行器替换为**内嵌的 DeepSeek
Harness(DSH)agent**。当会话路由到 `dsh/...` 模型引用时,你的消息不再走
OpenClaw 的模型传输层,而是交给一个**同进程内**的 DSH Agent,底下是完整的
DeepSeek Harness 技术栈:

- 自己的模型路由与推理强度(来自你的 DSH `settings.yaml`);
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
| 🔁 **会话不断线** | DSH 会话持久化到 `$DSH_HOME/sessions`,网关重启后自动恢复——对话扛得住重启。 |
| 🛠️ **沿用你的 DSH 配置** | 模型、凭据、技能全部来自你已经在用的 DeepSeek Harness,凭据零重复。 |
| 🧯 **失败得像个大人** | 中止、超时、凭据错误都会干净地变成 OpenClaw 运行失败——带着真实的 DSH 错误信息。 |
| 📦 **一个依赖块搞定** | 全部经 npm 安装:`@deepseek-ai/dsh-*` 纯 JS 包,无原生编译。 |

## 快速开始

```bash
# 1. 安装(源码安装需先 npm install && npm run build)
openclaw plugins install <本仓库路径>

# 2. 让 agent 指向 harness
openclaw config set agents.defaults.model "dsh/deepseek-v4-pro"

# 3. 直接对话
openclaw agent --local --agent main --message "你好,DeepSeek Harness"
```

就这么简单。`dsh/<任意模型名>` 都能解析——真正的模型由 DeepSeek Harness
自己决定(它的 `agent-default-model` 路由),你永远不用维护第二份模型目录。

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
│                           │ session/event 事件流               │
│   流式增量 · 推理 · 工具结果 ─────────────────────────────────▶ │
│                          回复管线                              │
└───────────────────────────────────────────────────────────────┘
```

1. **只启动一次。** 首次认领回合时,插件通过 `@deepseek-ai/dsh-app-boot`
   启动一棵 DSH 核心树(`dsh-base` profile bundle + 一小层补丁:关闭 HMR、
   设定 persona、钉住沙箱根目录)。
2. **每个 OpenClaw 会话一个 Agent。** 每个 OpenClaw 会话映射到一个稳定的
   DSH 会话 id(`oc-<session-id>`)。首次使用创建 Agent;之后的网关进程会从
   磁盘恢复这个持久化的 DSH 会话。
3. **桥接回合。** 用户输入经 `agent.followup(...)` 进入;作用域内的
   `session/event` 事件流把 `assistant/chunk` 增量映射到 `onPartialReply`、
   推理映射到 `onReasoningStream`、工具结果映射到 `onToolResult`,组装的
   消息写进回合结果。
4. **全程可逆。** 中止信号与回合超时会取消 DSH agent;回合结束前
   `sessions.flush` 持久化;`/new` 销毁该会话的 Agent;插件卸载时整个
   host 一并释放。

## 配置

所有字段均可选,位于 `openclaw.json` 的 `plugins.entries.dsh.config`:

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `dshHome` | `~/.dsh` | `$DSH_HOME`:settings、凭据与会话持久化的根目录 |
| `modelProvider` | DSH 自选 | 内嵌 agent 的模型路由覆盖 |
| `model` | DSH 自选 | 模型 id 覆盖(与 `modelProvider` 搭配) |
| `workspaceRoot` | `$HOME` | DSH 沙箱视为 workspace-write 的文件系统根 |
| `persona` | 内置 persona | 内嵌 agent 的系统提示词人设 |
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

在 `openclaw` **2026.7.1-2** + `@deepseek-ai/dsh-*` **0.1.0-rc.6** 上实测:

| 场景 | 结果 |
| --- | --- |
| `dsh/deepseek-v4-pro` 单轮回合 | ✅ 由内嵌 DSH agent 作答 |
| 跨两次网关进程的两轮回合 | ✅ 第二轮回合恢复持久化 DSH 会话并回忆起第一轮内容 |
| 凭据缺失 | ✅ 真实 DSH 错误以 OpenClaw 运行失败呈现;进程干净退出 |
| 插件加载 | ✅ `openclaw plugins inspect dsh` → loaded,hybrid-capability |

## 故障排查

| 症状 | 处理 |
| --- | --- |
| `no API key for provider route ...` | 配置 DSH 凭据(在 DSH web 的 Models 页写入 `~/.dsh/.credentials.yaml`)或在网关环境中导出 `DEEPSEEK_API_KEY` |
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

## 路线图

- [ ] 把 OpenClaw 工作区文件映射进 DSH agent 的引导上下文
- [ ] 通过受限的工具 preset 把 OpenClaw 工具桥接进 DSH
- [ ] 审批流程接入 OpenClaw 的审核 UI
- [ ] npm / ClawHub 分发

## 许可证

MIT —— 见 [LICENSE](LICENSE)。DeepSeek Harness 相关包均为 MIT 许可
([deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness))。

**英文文档**: [README](README.md)
