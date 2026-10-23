/**
 * OpenClaw conversation tool-policy enforcement for the embedded DSH runtime.
 *
 * Core preflight requires plugin harnesses to declare
 * `conversationToolPolicySupport: "exact"` when a conversation carries tool
 * restrictions (an allow-list, or denies beyond the harness's safe set), and
 * then passes the effective policy through the attempt params:
 * - `toolsAllow` — allowed canonical OpenClaw tool names/groups, where `[]`
 *   means "deny all" (core applies this for deny-all policies);
 * - `pluginHarnessToolPolicySafeDeniedTools` — canonical names the harness
 *   declared in `conversationToolPolicySafeDenyTools` and must deny.
 *
 * Enforcement maps the canonical policy onto DSH tool names and applies it
 * through the DSH tools service `restrict()` (agent-scoped, revocable):
 * restricted tools disappear from the model's schema, exactly like the
 * embedded runtime never submits disallowed tools. A `tools/pre-execute`
 * waterfall listener is registered as a hard backstop so a hallucinated call
 * for a restricted tool fails instead of executing.
 */
import { scopeOf } from "@deepseek-ai/dsh-scope";
import type { DshAgentLike } from "./types.js";

/** OpenClaw core tool groups (mirror of openclaw's CORE_TOOL_GROUPS). */
const OPENCLAW_CORE_TOOL_GROUPS: Readonly<Record<string, readonly string[]>> = {
  "group:fs": ["ls", "read", "write", "edit", "apply_patch"],
  "group:runtime": ["exec", "process", "code_execution", "secrets"],
  "group:web": ["web_search", "web_fetch", "x_search"],
  "group:memory": ["memory_search", "memory_get", "personal_instructions"],
  "group:agents": [
    "decision_evaluate",
    "agents_list",
    "get_goal",
    "create_goal",
    "update_goal",
    "progress_card",
    "ask_user",
    "skill_workshop",
    "skills_search",
    "skills_read",
  ],
  "group:sessions": [
    "presence",
    "sessions",
    "sessions_list",
    "sessions_history",
    "sessions_search",
    "conversations_list",
    "conversations_send",
    "conversations_turn",
    "sessions_send",
    "sessions_spawn",
    "github_identity_status",
    "github_publish",
    "agents_wait",
    "sessions_yield",
    "subagents",
    "session_status",
    "suggest_task",
    "dismiss_task",
  ],
  "group:ui": ["browser", "screen", "theme", "dashboard", "terminal", "portal", "canvas", "show_widget"],
  "group:messaging": ["message"],
  "group:automation": ["heartbeat_respond", "automations", "gateway", "plugins", "openclaw"],
  "group:nodes": ["nodes", "computer", "mobile_ui"],
  "group:media": ["view_image", "image_generate", "music_generate", "video_generate", "tts", "pdf"],
};

/** Canonical OpenClaw tool names and their DSH equivalents. */
const CANONICAL_TO_DSH: Readonly<Record<string, readonly string[]>> = {
  exec: ["bash"],
  // Background jobs are DSH's equivalent of the native process tool.
  process: ["bash", "job_output", "job_kill"],
  read: ["read"],
  write: ["write"],
  edit: ["edit"],
  ls: ["ls"],
  web_search: ["web_search"],
  web_fetch: ["web_fetch"],
};

/** The narrow DSH tools-service slice used for policy enforcement. */
interface DshToolsLike {
  restrict(filter: { allow?: string[]; deny?: string[] }): () => void;
  view(scope: unknown): { restrictableNames: ReadonlySet<string> };
}

/** The narrow DSH pre-execute gate a denial listener returns. */
interface DshToolGate {
  kind: "deny";
  reason: string;
}

function deniedReason(name: string): string {
  return `tool "${name}" is disabled by this conversation's tool policy`;
}

/** Expand canonical allow-list entries (names and group refs) into DSH names. */
function expandAllowlist(entries: readonly string[]): Set<string> {
  const dsh = new Set<string>();
  for (const entry of entries) {
    if (entry === "*") continue;
    const group = OPENCLAW_CORE_TOOL_GROUPS[entry];
    if (group !== undefined) {
      for (const name of group) {
        for (const mapped of CANONICAL_TO_DSH[name] ?? []) dsh.add(mapped);
      }
      continue;
    }
    for (const mapped of CANONICAL_TO_DSH[entry] ?? []) dsh.add(mapped);
  }
  return dsh;
}

/**
 * Apply this attempt's tool policy to the embedded DSH agent. Returns a
 * disposer that lifts every restriction registered for the attempt.
 *
 * - `toolsAllow` (allow-list; `[]` = deny all) wins over everything else;
 * - `pluginHarnessToolPolicySafeDeniedTools` denies the mapped tools when no
 *   allow-list is present;
 * - a `tools/pre-execute` listener vetoes restricted tools even when the
 *   model hallucinates a call for a tool it can no longer see.
 */
export function attachDshToolPolicy(
  agent: DshAgentLike,
  params: { toolsAllow?: string[]; pluginHarnessToolPolicySafeDeniedTools?: readonly string[]; disableTools?: boolean },
  log: (message: string) => void,
): () => void {
  const toolsAllow = params.toolsAllow;
  const safeDenied = params.pluginHarnessToolPolicySafeDeniedTools ?? [];
  const denyAll = params.disableTools === true || (Array.isArray(toolsAllow) && toolsAllow.length === 0);

  let allowedDsh: Set<string> | undefined;
  let deniedDsh: Set<string> | undefined;
  if (denyAll) {
    // Deny everything; the exact name set is filled from the tools view.
    deniedDsh = new Set();
  } else if (Array.isArray(toolsAllow) && toolsAllow.length > 0) {
    allowedDsh = expandAllowlist(toolsAllow);
    // A policy allow-list must not resurrect a separately denied tool.
    for (const name of safeDenied) for (const mapped of CANONICAL_TO_DSH[name] ?? []) allowedDsh.delete(mapped);
  } else if (safeDenied.length > 0) {
    deniedDsh = new Set(safeDenied.flatMap((name) => [...(CANONICAL_TO_DSH[name] ?? [])]));
  }
  if ((allowedDsh === undefined || allowedDsh.size === 0) && (deniedDsh === undefined || deniedDsh.size === 0) && !denyAll) {
    return () => {};
  }

  const disposers: Array<() => void> = [];
  // The pre-execute veto is the hard guarantee; restrict() additionally hides
  // the tools from the model so it does not waste turns on calls it cannot
  // make. With an allow-list (or deny-all), everything outside the allowed
  // set is vetoed; with a pure deny-list, exactly the denied names are.
  const isVetoed = (name: string): boolean =>
    allowedDsh !== undefined
      ? !allowedDsh.has(name)
      : denyAll
        ? true
        : deniedDsh !== undefined
          ? deniedDsh.has(name)
          : false;
  const detach = agent.ctx.on("tools/pre-execute", (exec: { name?: unknown }, next: () => unknown): unknown => {
    if (typeof exec?.name === "string" && isVetoed(exec.name)) {
      return { kind: "deny", reason: deniedReason(exec.name) } satisfies DshToolGate;
    }
    return next();
  });
  disposers.push(() => {
    try {
      detach();
    } catch {
      agent.ctx.off?.("tools/pre-execute", detach);
    }
  });

  try {
    const tools = agent.ctx.get?.("tools") as DshToolsLike | undefined;
    if (tools === undefined || typeof tools.restrict !== "function") {
      log(`tool policy enforced via pre-execute veto only: tools service unavailable`);
      return lift;
    }
    const restrictable = tools.view(scopeOf(agent.ctx as Parameters<typeof scopeOf>[0])).restrictableNames;
    const filter: { allow?: string[]; deny?: string[] } = {};
    if (denyAll) {
      filter.deny = [...restrictable];
    } else if (allowedDsh !== undefined) {
      const visible = [...allowedDsh].filter((name) => restrictable.has(name));
      if (visible.length === 0) filter.deny = [...restrictable];
      else filter.allow = visible;
    } else if (deniedDsh !== undefined) {
      const mapped = [...deniedDsh].filter((name) => restrictable.has(name));
      if (mapped.length > 0) filter.deny = mapped;
    }
    if (filter.allow !== undefined || filter.deny !== undefined) {
      const liftRestriction = tools.restrict(filter);
      disposers.push(liftRestriction);
      log(
        `DSH tool policy applied: ${filter.allow !== undefined ? `allow=[${filter.allow.join(",")}]` : ""}${filter.deny !== undefined ? ` deny=[${filter.deny.join(",")}]` : ""}`,
      );
    }
  } catch (error) {
    log(`tool policy restrict() failed, pre-execute veto remains active: ${String(error)}`);
  }

  function lift(): void {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        // already disposed
      }
    }
  }
  return lift;
}
