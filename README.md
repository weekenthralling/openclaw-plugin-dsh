# openclaw-plugin-dsh

> **Author**: this plugin was written entirely by **DeepSeek V4 Pro**
> (`deepseek-v4-pro`), running as a DeepSeek Harness agent.

Run OpenClaw agent turns through an embedded **DeepSeek Harness (DSH)** agent.

Instead of OpenClaw's built-in runner, the `dsh` agent harness boots one DSH
core tree inside the OpenClaw gateway process and hands each OpenClaw session
its own DSH Agent. The DeepSeek Harness keeps its own model route, persona,
tools (bash/fs/search/subagents/goals/…), session persistence, and compaction;
OpenClaw keeps channels, sessions, routing, and the visible transcript — the
same split OpenClaw uses for its Codex harness.

## What you get

- `dsh/<model>` model refs resolve and route to the embedded DSH agent
  (any `dsh/<model>` id is accepted; the actual model comes from DSH config).
- Cross-restart session continuity: DSH sessions persist to
  `$DSH_HOME/sessions` and resume per OpenClaw session.
- Streaming replies, reasoning, and tool-result previews bridge into
  OpenClaw's reply pipeline.
- `/new` (session reset) disposes the DSH agent for that session.
- DSH failures surface as OpenClaw run failures with the real DSH error.

## Install

```bash
# From a source checkout: build first
npm install && npm run build

openclaw plugins install <path-to-this-package>
# or from a packed tarball (proves the managed npm install shape):
npm pack && openclaw plugins install npm-pack:openclaw-plugin-dsh-0.1.0.tgz
```

Restart the gateway after install. Verify:

```bash
openclaw plugins inspect dsh --runtime
```

If your `openclaw.json` uses a restrictive allowlist, add `dsh` to
`plugins.allow`.

## Activate

Either use a `dsh/...` model ref (recommended):

```json5
// openclaw.json
{
  agents: { defaults: { model: "dsh/deepseek-v4-pro" } },
}
```

or pin the harness on any existing model entry:

```json5
{
  agents: {
    defaults: {
      model: "openai/gpt-5.5",
      models: {
        "openai/gpt-5.5": { agentRuntime: { id: "dsh" } },
      },
    },
  },
}
```

## Credentials and model choice

The embedded host reads the machine's DeepSeek Harness configuration
(`$DSH_HOME`, default `~/.dsh`): `settings.yaml` picks the provider/model
(and reasoning effort), and credentials come from `~/.dsh/.credentials.yaml`
(written by the DSH web Models page) or `DEEPSEEK_API_KEY` in the gateway
environment.

## Configuration

Optional, under `plugins.entries.dsh.config`:

| Field           | Default          | Meaning                                                        |
| --------------- | ---------------- | -------------------------------------------------------------- |
| `dshHome`       | `~/.dsh`         | `$DSH_HOME` for settings, credentials, and session persistence |
| `modelProvider` | DSH selection    | Provider route override for embedded agents                    |
| `model`         | DSH selection    | Model id override (used with `modelProvider`)                  |
| `workspaceRoot` | `$HOME`          | Filesystem root the DSH sandbox treats as workspace-write      |
| `persona`       | built-in persona | System-prompt persona for the embedded agent                   |
| `turnTimeoutMs` | `900000`         | Safety cap for one embedded DSH turn                           |

Sandbox policy follows `DSH_PERMISSION_MODE` (default `workspace-write`; set
`danger-full-access` for unattended gateway use, since DSH approval prompts
have no interactive answerer in this embedding).

## Debugging

```bash
OPENCLAW_DSH_DEBUG=1 openclaw agent --local --agent main \
  --message "hi" --model dsh/deepseek-v4-pro
```

Common failures:

- `no API key for provider route ...` — configure DSH credentials
  (`~/.dsh/.credentials.yaml` via the DSH web Models page, or export
  `DEEPSEEK_API_KEY` in the gateway environment).
- `plugins.allow` warning — add `"dsh"` to `plugins.allow` in `openclaw.json`.

## How it works

1. The plugin entry is SDK-free and load-lightweight; it registers a
   synthetic `dsh` provider (pass-through `resolveDynamicModel`) and the
   `dsh` agent harness at startup.
2. On the first claimed attempt, the harness boots one embedded DSH host
   (profile template in `config/`: `@deepseek-ai/dsh-base` bundle plus a
   patch layer disabling HMR, setting the persona, and pinning the sandbox
   root). The host is disposed on plugin unload.
3. Each OpenClaw session maps to a DSH session id (`oc-<session-id>`);
   first use creates an Agent, later processes resume the persisted DSH
   session, and the agent stays live for the process lifetime.
4. Per turn: the user prompt is sent via `agent.followup(...)`; the
   `session/event` firehose bridges `assistant/chunk` deltas to
   `onPartialReply`, reasoning to `onReasoningStream`, tool results to
   `onToolResult`, and assembled messages to the attempt result.
5. Abort/`timeoutMs` cancel the DSH agent; `sessions.flush` persists before
   the attempt resolves; the result shape is the normalized
   `AgentHarnessAttemptResult` OpenClaw's pipeline expects.

## Limitations

- OpenClaw's agent-harness surface for third-party plugins is still marked
  experimental; this plugin is validated against `openclaw` 2026.7.1-2 and
  `@deepseek-ai/dsh-*` 0.1.0-rc.6.
- OpenClaw's own tools, custom instructions, and system prompt do not flow
  into the DSH agent — DSH runs its own tool ecosystem and persona
  (`extraSystemPrompt` is bridged as injected context).
- One embedded host per gateway process means one global `workspaceRoot`;
  per-session `cwd` still follows the OpenClaw session workspace.
- DSH compaction and goals run inside DSH's own loop; OpenClaw-side
  preflight compaction does not apply to DSH sessions.

## License

MIT. DeepSeek Harness packages are MIT-licensed (deepseek-ai/deepseek-harness).
