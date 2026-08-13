# openclaw-plugin-dsh

<div align="center">

**Give your OpenClaw the brain of DeepSeek Harness — one model ref away.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-2026.7.1--2-222222)](https://docs.openclaw.ai)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek_Harness-0.1.0--rc.6-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![Author](https://img.shields.io/badge/written_by-DeepSeek_V4_Pro-8A2BE2)](https://api-docs.deepseek.com)

> **Written entirely by DeepSeek V4 Pro** — every line of this plugin was
> authored by a DeepSeek Harness agent running on `deepseek-v4-pro`.

</div>

## What it does

`openclaw-plugin-dsh` replaces the turn executor inside OpenClaw with an
**embedded DeepSeek Harness (DSH) agent**. When a session routes to a
`dsh/...` model ref, your message no longer goes through OpenClaw's
provider transport — it is handed to a live DSH Agent running **in the same
process**, with the full DeepSeek Harness stack underneath:

- its own model route and reasoning effort (from your DSH `settings.yaml`),
- its own tools — bash, file search, editing, subagents, workflows, goals,
  web search, and more,
- its own session persistence and compaction,
- streaming deltas bridged back into OpenClaw's reply pipeline.

OpenClaw keeps what it is good at — channels, routing, sessions, the visible
transcript — while DSH owns the agent loop. It is the same split OpenClaw
uses for its own Codex harness, now available for the DeepSeek Harness.

## Why you want it

| | |
| --- | --- |
| ⚡ **Zero-latency handoff** | No subprocess, no HTTP, no websocket. The DSH host boots in-process, so each turn starts instantly. |
| 🧠 **A real agent, not a model call** | DSH plans, runs tools, compacts, spawns subagents, and tracks goals inside one turn. |
| 🎭 **Agent presets per session** | `standard` / `code` / `cordis` / `minimal` compositions out of the box, plus your own presets under `$DSH_HOME/.agent-presets/<id>/` — each OpenClaw agent picks its own tools, persona, and skills. |
| 🔌 **Self-modifying runtime** | With the `cordis` preset, the embedded agent can `cordis_define` → `cordis_run` → `cordis_stop` temporary plugins at runtime — extend itself during a conversation. |
| 🔁 **Session continuity** | DSH sessions persist to `$DSH_HOME/sessions` and resume across gateway restarts — conversations *and their preset* survive reboots. |
| 🛠️ **Bring your DSH config** | Model, credentials, and skills come from the DeepSeek Harness you already run. Zero credential duplication. |
| 🧯 **Fails like a grown-up** | Aborts, timeouts, and credential errors surface as clean OpenClaw run failures — with the real DSH error message. |
| 📦 **One dependency block** | Everything ships through npm: `@deepseek-ai/dsh-*` packages, pure JS, no native builds. |

## Quick start

```bash
# 1. Install (ClawHub, recommended):
openclaw plugins install clawhub:openclaw-deepseek-harness
# or from a source checkout: npm install && npm run build first
openclaw plugins install <path-to-this-package>

# 2. Point an agent at the harness
openclaw config set agents.defaults.model "dsh/deepseek-v4-pro"

# 3. Talk to it
openclaw agent --local --agent main --message "Hello from DeepSeek Harness"
```

That's it. `dsh/<any-model-id>` refs are accepted — the actual model is
chosen by the DeepSeek Harness itself (its `agent-default-model` route),
so you never maintain a second model catalog.

## How it works

```
OpenClaw gateway process
┌───────────────────────────────────────────────────────────────┐
│  channel / session / routing / transcript        (OpenClaw)   │
│                        │                                       │
│                        ▼  prepared attempt                     │
│   ┌─────────────────────────────────────────────┐             │
│   │        dsh agent harness (this plugin)      │             │
│   │  supports() · runAttempt() · reset()        │             │
│   └───────────────────────┬─────────────────────┘             │
│                           │                                    │
│   ┌───────────────────────▼─────────────────────┐             │
│   │        embedded DeepSeek Harness host       │             │
│   │  dsh-base bundle · model route · sandbox    │             │
│   │   ┌─────────┐  ┌─────────┐  ┌────────────┐  │             │
│   │   │ Agent A │  │ Agent B │  │ Agent …    │  │             │
│   │   │ session │  │ session │  │            │  │             │
│   │   └─────────┘  └─────────┘  └────────────┘  │             │
│   └───────────────────────┬─────────────────────┘             │
│                           │ session/event firehose             │
│   streaming deltas · reasoning · tool results ───────────────▶ │
│                          reply pipeline                        │
└───────────────────────────────────────────────────────────────┘
```

1. **Boot once.** On the first claimed attempt, the plugin boots one DSH
   core tree (the `dsh-base` profile bundle plus a small patch layer:
   HMR off, persona, sandbox root) through `@deepseek-ai/dsh-app-boot`.
2. **One Agent per OpenClaw session.** Each OpenClaw session maps to a
   stable DSH session id (`oc-<session-id>`). First use creates the Agent;
   later gateway processes resume the persisted DSH session from disk.
3. **Bridge the turn.** The user prompt enters via `agent.followup(...)`;
   the scoped `session/event` firehose maps `assistant/chunk` deltas to
   `onPartialReply`, reasoning to `onReasoningStream`, tool results to
   `onToolResult`, and assembled messages to the attempt result.
4. **Stay reversible.** Abort signals and the turn timeout cancel the DSH
   agent; `sessions.flush` persists before the attempt resolves; `/new`
   disposes the session's Agent; plugin unload disposes the whole host.

## Configuration

All fields are optional, under `plugins.entries.dsh.config` in
`openclaw.json`:

| Field | Default | Meaning |
| --- | --- | --- |
| `dshHome` | `~/.dsh` | `$DSH_HOME` for settings, credentials, and session persistence |
| `modelProvider` | DSH selection | Provider route override for embedded agents |
| `model` | DSH selection | Model id override (used with `modelProvider`) |
| `workspaceRoot` | `$HOME` | Filesystem root the DSH sandbox treats as workspace-write |
| `persona` | built-in persona | System-prompt persona for the embedded agent |
| `agentPreset` | `standard` | DSH agent preset per session: `standard`, `code`, `cordis` (adds the dynamic Cordis plugin toolset), `minimal`, or a preset you authored under `$DSH_HOME/.agent-presets/<id>/` |
| `allowDynamicPlugins` | `true` | Mount the dynamic Cordis plugin runtime (`cordis_define` / `cordis_run` / `cordis_inspect_*` / `cordis_stop`) so agents on the `cordis` preset can extend themselves at runtime |
| `turnTimeoutMs` | `900000` | Safety cap for one embedded DSH turn |

```json5
{
  plugins: {
    entries: {
      dsh: {
        config: {
          modelProvider: "deepseek-official",
          model: "deepseek-v4-pro",
          workspaceRoot: "/Users/me/projects",
          agentPreset: "cordis", // self-modifying agent
        },
      },
    },
  },
}
```

> **Authoring your own preset**: copy a shipped composition
> (`~/.dsh/.agent-presets/<id>/`), edit the rows, and set `agentPreset` to
> your id — your OpenClaw agent gets exactly the tools, persona, and skills
> you choose. The `cordis` preset ships with the
> `editing-cordis-compositions` skill that documents this.

## Activation modes

```json5
// A. dsh model ref (recommended) — any dsh/<model> id resolves
{ agents: { defaults: { model: "dsh/deepseek-v4-pro" } } }

// B. Pin the harness on an existing model entry
{
  agents: {
    defaults: {
      model: "openai/gpt-5.5",
      models: { "openai/gpt-5.5": { agentRuntime: { id: "dsh" } } },
    },
  },
}
```

## Verified end to end

Validated on `openclaw` **2026.7.1-2** + `@deepseek-ai/dsh-*` **0.1.0-rc.6**:

| Scenario | Result |
| --- | --- |
| Single turn via `dsh/deepseek-v4-pro` | ✅ answered by the embedded DSH agent |
| Two turns across separate gateway processes | ✅ turn 2 resumed the persisted DSH session and recalled turn-1 context |
| Agent preset (`cordis`) mounted at creation | ✅ `cordis_inspect_list` ran through OpenClaw and listed 4 host providers |
| Dynamic plugin lifecycle in-turn | ✅ agent did `cordis_define` → `cordis_run` (plugin applied live) → `cordis_stop` |
| Preset survives restart | ✅ resumed session re-mounted its recorded preset from the persisted log |
| Credential failure | ✅ real DSH error surfaced as an OpenClaw run failure; clean shutdown |
| Plugin load | ✅ `openclaw plugins inspect dsh` → loaded, hybrid-capability |

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `no API key for provider route ...` | Configure DSH credentials (`~/.dsh/.credentials.yaml` via the DSH web Models page) or export `DEEPSEEK_API_KEY` in the gateway environment |
| `plugins.allow` warning | Add `"dsh"` to `plugins.allow` in `openclaw.json` |
| Nothing happens / want visibility | Run the gateway with `OPENCLAW_DSH_DEBUG=1` |

## Known limitations

- OpenClaw's agent-harness surface for third-party plugins is still
  experimental; this plugin pins the validated version pair above.
- OpenClaw's own tools and custom instructions do not flow into the DSH
  agent — DSH runs its own tool ecosystem and persona
  (`extraSystemPrompt` is bridged as injected context).
- One embedded host per gateway process means one global `workspaceRoot`;
  per-session working directories still follow the OpenClaw session.
- DSH approval prompts have no interactive answerer in this embedding, so
  sandbox escalations fail closed unless you set
  `DSH_PERMISSION_MODE=danger-full-access` for unattended gateways.
- Dynamic plugins that include a Client (browser) half need an approval UI;
  in this embedding host-only packages run directly, while Client packages
  fail closed without an interactive reviewer.

## Roadmap

- [x] ClawHub distribution (`clawhub:openclaw-deepseek-harness`)
- [x] DSH agent presets + dynamic Cordis plugin runtime
- [ ] Map OpenClaw workspace files into the DSH agent bootstrap context
- [ ] Optional bridge of OpenClaw tools into DSH via a scoped tool preset
- [ ] Approvals surfaced through OpenClaw's review UI
- [ ] npm distribution

## License

MIT — see [LICENSE](LICENSE). DeepSeek Harness packages are MIT-licensed
([deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)).

**Chinese docs**: [中文说明](README.zh-CN.md)
