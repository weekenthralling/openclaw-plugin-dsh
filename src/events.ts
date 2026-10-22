/**
 * Event bridge: maps DSH session events onto OpenClaw attempt callbacks and
 * turn facts.
 *
 * DSH event shapes (verified against @deepseek-ai/dsh-* 0.2.0-rc.2):
 * - `agent/assistant-stream` (agent-scoped, emit) — live frames:
 *   `{ type: "start" | "chunk" | "end", attemptId, revision, turn, step,
 *   chunk?: StreamChunk, index, outcome? }`. One opening `start` is published
 *   per model call attempt; a retried step opens another `start` with the same
 *   turn/step. Chunk frames are transient; the loop commits one final
 *   `assistant/message` before the end frame.
 * - `session/event` durable firehose (scoped on the agent context):
 *   - `assistant/message` { turn, step, message, usage?, interrupted? }
 *   - `tool/call`          { turn, step, callId, name, arguments }
 *   - `tool/result`        { turn, step, message, error?, meta? }
 *   - `turn/start` / `turn/end` { turn, reason }
 *
 * Streaming contract for OpenClaw 2026.10.5 (verified against dist):
 * - `onPartialReply` must carry cumulative `text`; the embedded presentation
 *   path reads `payload.text` only and drops delta-only payloads.
 * - The Control UI's live text is driven by global agent events
 *   (`{stream: "assistant", data: {itemId, text, delta, replace?}}`), so the
 *   bridge also forwards every snapshot through `onAssistantStream`.
 * - Text is cumulative within one assistant message (one turn step) and
 *   restarts at each new message, mirroring the native harness stream.
 * - Tool calls are published as `{stream: "tool", data: {phase, name,
 *   toolCallId, args?, result?, isError?, meta?}}`; the Control UI's tool cards
 *   are built from these events (and they are only delivered to clients that
 *   advertised the `tool-events` capability). `toolMetas` alone only feeds
 *   the attempt result, not the page.
 * - Tool activity items are published as `{stream: "item", data: {kind:
 *   "tool", itemId, toolCallId, name, phase, title, status, meta?,
 *   commandBearing}}`, mirroring the native harness's
 *   `projectAgentToolActivity`; the Control UI renders the descriptive tool
 *   title line and terminal icon from these events, not from `stream:"tool"`.
 * - The same durable events are mirrored into OpenClaw's transcript by the
 *   transcript observer (see transcript.ts), so tool calls survive a refresh.
 */
import { randomUUID } from "node:crypto";
import type { BridgeCallbacks, DshCordisContextLike, TurnFacts } from "./types.js";
import { argumentsRecord, normalizeDshUsage, type TranscriptObserver } from "./transcript.js";

const TOOL_RESULT_PREVIEW_CHARS = 400;
/** Native harness caps live tool-result text at 8k chars before publishing. */
const TOOL_RESULT_EVENT_MAX_CHARS = 8000;

/**
 * Compact display facts for one tool invocation, mirroring OpenClaw's
 * `tool-display` projection: a label, a one-line meta describing the
 * invocation, and whether the call carries a command (terminal icon in the
 * Control UI). DSH tools carry a model-generated `description` argument
 * ("shown in the UI", required for bash/pwsh) — it is preferred, exactly like
 * the native harness prefers the tool's own presentation metadata; the
 * arg-derived keys (command, path, …) are the fallback for tools without one.
 */
export interface ToolDisplay {
  label: string;
  /** Compact invocation summary, e.g. the command for a bash call. */
  meta?: string;
  /** Shell-family tools (or any tool with a `command` argument). */
  commandBearing: boolean;
}

/** Label + detail keys per tool, mirroring openclaw's TOOL_DISPLAY_CONFIG. */
const TOOL_DISPLAY_TABLE: Record<string, { label: string; detailKeys: string[] }> = {
  bash: { label: "Bash", detailKeys: ["command"] },
  exec: { label: "Exec", detailKeys: ["command"] },
  shell: { label: "Shell", detailKeys: ["command"] },
  terminal: { label: "Terminal", detailKeys: ["command"] },
  read: { label: "Read", detailKeys: ["path", "file_path"] },
  write: { label: "Write", detailKeys: ["path", "file_path"] },
  edit: { label: "Edit", detailKeys: ["path", "file_path"] },
  web_search: { label: "Web Search", detailKeys: ["query", "queries"] },
  web_fetch: { label: "Web Fetch", detailKeys: ["url"] },
};

/** Native fallback detail keys for tools without a display spec. */
const FALLBACK_DETAIL_KEYS = [
  "command",
  "path",
  "file_path",
  "url",
  "targetUrl",
  "targetId",
  "ref",
  "element",
  "node",
  "nodeId",
  "id",
  "requestId",
  "to",
  "channelId",
  "guildId",
  "userId",
  "name",
  "query",
  "pattern",
  "messageId",
];

const TOOL_META_MAX_CHARS = 200;

function displayLabel(name: string): string {
  const spec = TOOL_DISPLAY_TABLE[name.trim().toLowerCase()];
  if (spec !== undefined) return spec.label;
  const words = name.trim().replace(/_+/g, " ").replace(/\s+/g, " ");
  return words === ""
    ? "Tool"
    : words.charAt(0).toUpperCase() + words.slice(1);
}

function firstStringArg(args: unknown, keys: string[]): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
    // Array-valued arguments (e.g. DSH web_search `queries`): use the first
    // non-empty string entry as the display detail.
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim() !== "") return item;
      }
    }
  }
  return undefined;
}

/** One-line invocation summary, whitespace-collapsed like the native display. */
function collapseMeta(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim();
  const home = process.env.HOME;
  const short =
    home !== undefined && home !== "" && text.startsWith(`${home}/`)
      ? `~${text.slice(home.length)}`
      : home !== undefined && text === home
        ? "~"
        : text;
  return short.length > TOOL_META_MAX_CHARS ? `${short.slice(0, TOOL_META_MAX_CHARS)}…` : short;
}

/** Label/meta/command-bearing facts for a DSH tool invocation. */
export function toolDisplayFor(name: string, args: unknown): ToolDisplay {
  const key = name.trim().toLowerCase();
  const spec = TOOL_DISPLAY_TABLE[key];
  const command = firstStringArg(args, ["command"]);
  const commandBearing =
    key === "bash" || key === "exec" || key === "shell" || command !== undefined;
  const raw =
    firstStringArg(args, ["description"]) ??
    (spec !== undefined
      ? firstStringArg(args, spec.detailKeys)
      : firstStringArg(args, FALLBACK_DETAIL_KEYS));
  return {
    label: displayLabel(name),
    ...(raw === undefined ? {} : { meta: collapseMeta(raw) }),
    commandBearing,
  };
}

/**
 * Parse DSH's JSON-encoded tool arguments for the live tool card. The Control
 * UI titles a bash card from `args.title` (command only as fallback), so
 * DSH's model-generated `description` is surfaced as `title` (see
 * argumentsRecord).
 */
function parseToolArguments(value: unknown): unknown {
  if (typeof value !== "string") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    const description = record.description;
    if (
      typeof description === "string" &&
      description.trim() !== "" &&
      (typeof record.title !== "string" || record.title.trim() === "")
    ) {
      return { ...record, title: description };
    }
    return value;
  }
  const text = value.trim();
  if (text === "") return undefined;
  try {
    return argumentsRecord(JSON.parse(text));
  } catch {
    return text;
  }
}

/** Join the text blocks of a DSH message (user/assistant/tool shapes share it). */
function messageText(message: unknown): string {
  const candidate = message as { content?: Array<{ type?: string; text?: string }> };
  const blocks = Array.isArray(candidate?.content) ? candidate.content : [];
  return blocks
    .filter((block) => block !== null && typeof block === "object" && block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/** Fresh per-turn collector. */
export function createTurnFacts(): TurnFacts {
  return {
    assistantTexts: [],
    deltaText: "",
    reasoningText: "",
    toolMetas: [],
    turnEndReason: undefined,
    usage: undefined,
    started: false,
    toolActivity: false,
    completedToolResults: 0,
  };
}

interface SessionEventLike {
  type: string;
  seq?: number;
  time?: number;
  data: Record<string, unknown>;
}

/**
 * Subscribe the bridge listeners on the agent-scoped context. `on` returns the
 * disposer (Cordis effect contract); the agent-scoped registrations receive
 * only this agent's `agent/assistant-stream` frames and session events.
 */
export function attachEventBridge(
  agentCtx: DshCordisContextLike,
  callbacks: BridgeCallbacks,
  facts: TurnFacts,
  transcript?: TranscriptObserver,
): () => void {
  const pendingCalls = new Map<
    string,
    { name: string; meta: TurnFacts["toolMetas"][number] }
  >();

  // Live assistant-text bookkeeping. DSH frames one assistant message per
  // turn step; a failed model call retries the same step with a fresh
  // `start` frame, whose partial text must replace the failed attempt's.
  const streamId = randomUUID();
  let streamItemIndex = 0;
  let streamItemId = `${streamId}:0`;
  let streamMessageKey: string | undefined;
  let streamText = "";
  let streamReplacePending = false;

  const handleSessionEvent = (event: SessionEventLike): void => {
    const data = event.data ?? {};
    // Persist durable surface events before any presentation work so a slow
    // UI callback cannot reorder or drop transcript writes.
    transcript?.observe(event);
    switch (event.type) {
      case "turn/start": {
        facts.deltaText = "";
        facts.reasoningText = "";
        facts.started = false;
        break;
      }
      case "turn/end": {
        facts.turnEndReason = data.reason as TurnFacts["turnEndReason"];
        break;
      }
      case "assistant/message": {
        const text = messageText(data.message);
        if (text !== "") {
          facts.assistantTexts.push(text);
          facts.deltaText = "";
        }
        if (data.usage !== undefined) facts.usage = normalizeDshUsage(data.usage);
        break;
      }
      case "tool/call": {
        facts.toolActivity = true;
        const name = typeof data.name === "string" ? data.name : "unknown";
        const callId = typeof data.callId === "string" ? data.callId : undefined;
        const meta: TurnFacts["toolMetas"][number] = {
          toolName: name,
          ...(callId === undefined ? {} : { toolCallId: callId }),
        };
        facts.toolMetas.push(meta);
        if (callId !== undefined) {
          pendingCalls.set(callId, { name, meta });
          callbacks.onToolEvent?.({
            phase: "start",
            toolCallId: callId,
            name,
            args: parseToolArguments(data.arguments),
          });
        }
        break;
      }
      case "tool/result": {
        facts.completedToolResults += 1;
        // The result event carries the id on its first-class tool message, not
        // at the top level; fall back to a top-level id for older producers.
        const message = data.message as
          | { toolCallId?: unknown; isError?: unknown }
          | undefined;
        const callId =
          typeof message?.toolCallId === "string"
            ? message.toolCallId
            : typeof data.callId === "string"
              ? data.callId
              : undefined;
        const pending = callId === undefined ? undefined : pendingCalls.get(callId);
        const name = pending?.name ?? "tool";
        const isError = message?.isError === true || data.error !== undefined;
        if (callId !== undefined && pending !== undefined) {
          pending.meta.isError = isError;
          pendingCalls.delete(callId);
        }
        const text = messageText(data.message);
        if (callId !== undefined) {
          callbacks.onToolEvent?.({
            phase: "result",
            toolCallId: callId,
            name,
            result: truncate(text, TOOL_RESULT_EVENT_MAX_CHARS),
            isError,
            ...(data.meta !== undefined ? { meta: data.meta } : {}),
          });
        }
        if (text.trim() !== "") {
          void callbacks.onToolResult?.({ text: `[${name}] ${truncate(text, TOOL_RESULT_PREVIEW_CHARS)}` });
        }
        break;
      }
      default:
        break;
    }
  };

  /** One live `agent/assistant-stream` frame (transient publication). */
  const handleStreamFrame = (frame: {
    type?: string;
    turn?: unknown;
    step?: unknown;
    chunk?: { type?: string; text?: string };
  }): void => {
    const type = frame.type;
    if (type === "start") {
      // DSH always stamps turn/step; without them no retry can be recognized.
      const messageKey =
        typeof frame.turn === "number" && typeof frame.step === "number"
          ? `${frame.turn}:${frame.step}`
          : undefined;
      // A second start for the same step is a retried model call: restart the
      // message content instead of appending to the failed attempt's text.
      streamReplacePending = messageKey !== undefined && messageKey === streamMessageKey;
      streamMessageKey = messageKey;
      streamItemIndex += 1;
      streamItemId = `${streamId}:${streamItemIndex}`;
      streamText = "";
      if (streamReplacePending) facts.deltaText = "";
      return;
    }
    const chunk = frame.chunk;
    if (type !== "chunk" || chunk === undefined) return;
    if (chunk.type === "text-delta" && typeof chunk.text === "string" && chunk.text !== "") {
      if (!facts.started) {
        facts.started = true;
        void callbacks.onAssistantMessageStart?.();
      }
      facts.deltaText += chunk.text;
      streamText += chunk.text;
      const replace = streamReplacePending;
      streamReplacePending = false;
      const delta = replace ? "" : chunk.text;
      void callbacks.onPartialReply({
        text: streamText,
        delta,
        ...(replace ? { replace: true as const } : {}),
      });
      callbacks.onAssistantStream?.({
        itemId: streamItemId,
        text: streamText,
        delta,
        ...(replace ? { replace: true as const } : {}),
      });
    } else if (chunk.type === "reasoning-delta" && typeof chunk.text === "string") {
      facts.reasoningText += chunk.text;
      void callbacks.onReasoningStream?.({ text: chunk.text, isReasoning: true });
    }
  };

  const sessionListener = (_session: unknown, event: unknown): void => {
    const candidate = event as SessionEventLike;
    if (candidate !== null && typeof candidate === "object" && typeof candidate.type === "string") {
      handleSessionEvent(candidate);
    }
  };

  const streamListener = (payload: unknown): void => {
    const candidate = payload as { frame?: { type?: string; chunk?: { type?: string; text?: string } } };
    if (candidate !== null && typeof candidate === "object" && candidate.frame !== undefined) {
      handleStreamFrame(candidate.frame);
    }
  };

  const sessionDisposer = agentCtx.on("session/event", sessionListener);
  const streamDisposer = agentCtx.on("agent/assistant-stream", streamListener);
  return () => {
    try {
      sessionDisposer();
    } catch {
      agentCtx.off?.("session/event", sessionListener);
    }
    try {
      streamDisposer();
    } catch {
      agentCtx.off?.("agent/assistant-stream", streamListener);
    }
  };
}
