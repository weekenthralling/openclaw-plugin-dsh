/**
 * Event bridge: maps DSH session events onto OpenClaw attempt callbacks and
 * turn facts.
 *
 * DSH event shapes (verified against @deepseek-ai/dsh-* 0.2.0-rc.2):
 * - `agent/assistant-stream` (agent-scoped, emit) — live frames:
 *   `{ type: "start" | "chunk" | "end", attemptId, revision, turn, step,
 *   chunk?: StreamChunk, index, outcome? }`. Chunk frames are transient; the
 *   loop commits one final `assistant/message` before the end frame.
 * - `session/event` durable firehose (scoped on the agent context):
 *   - `assistant/message` { turn, step, message, usage?, interrupted? }
 *   - `tool/call`          { turn, step, callId, name, arguments }
 *   - `tool/result`        { turn, step, message, error?, meta? }
 *   - `turn/start` / `turn/end` { turn, reason }
 */
import type { BridgeCallbacks, DshCordisContextLike, TurnFacts } from "./types.js";

const TOOL_RESULT_PREVIEW_CHARS = 400;

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
): () => void {
  const pendingCalls = new Map<string, string>();

  const handleSessionEvent = (event: SessionEventLike): void => {
    const data = event.data ?? {};
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
        if (data.usage !== undefined) facts.usage = data.usage;
        break;
      }
      case "tool/call": {
        facts.toolActivity = true;
        const name = typeof data.name === "string" ? data.name : "unknown";
        facts.toolMetas.push({ toolName: name });
        if (typeof data.callId === "string") pendingCalls.set(data.callId, name);
        break;
      }
      case "tool/result": {
        facts.completedToolResults += 1;
        const callId = typeof data.callId === "string" ? data.callId : undefined;
        const name = (callId !== undefined ? pendingCalls.get(callId) : undefined) ?? "tool";
        if (callId !== undefined) pendingCalls.delete(callId);
        const text = messageText(data.message);
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
    chunk?: { type?: string; text?: string };
  }): void => {
    const chunk = frame.chunk;
    if (frame.type !== "chunk" || chunk === undefined) return;
    if (chunk.type === "text-delta" && typeof chunk.text === "string") {
      if (!facts.started) {
        facts.started = true;
        void callbacks.onAssistantMessageStart?.();
      }
      facts.deltaText += chunk.text;
      void callbacks.onPartialReply({ delta: chunk.text });
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
