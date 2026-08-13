/**
 * Event bridge: maps DSH session events (the scoped `session/event` firehose on
 * the agent context) onto OpenClaw attempt callbacks and turn facts.
 *
 * DSH event shapes (verified against @deepseek-ai/dsh-session 0.1.0-rc.6):
 * - `assistant/chunk`  { turn, step, chunk: StreamChunk }        live deltas
 * - `assistant/message`{ turn, step, message, usage? }           assembled step text
 * - `tool/call`        { turn, step, callId, name, arguments }
 * - `tool/result`      { turn, step, message, error?, meta? }
 * - `turn/start` / `turn/end` { turn, reason }
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
 * Subscribe one listener on the agent-scoped context. `on` returns the
 * disposer (Cordis effect contract).
 */
export function attachEventBridge(
  agentCtx: DshCordisContextLike,
  callbacks: BridgeCallbacks,
  facts: TurnFacts,
): () => void {
  const pendingCalls = new Map<string, string>();

  const handle = (event: SessionEventLike): void => {
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
      case "assistant/chunk": {
        const chunk = data.chunk as {
          type?: string;
          text?: string;
        };
        if (chunk?.type === "text-delta" && typeof chunk.text === "string") {
          if (!facts.started) {
            facts.started = true;
            void callbacks.onAssistantMessageStart?.();
          }
          facts.deltaText += chunk.text;
          void callbacks.onPartialReply({ delta: chunk.text });
        } else if (chunk?.type === "reasoning-delta" && typeof chunk.text === "string") {
          facts.reasoningText += chunk.text;
          void callbacks.onReasoningStream?.({ text: chunk.text, isReasoning: true });
        }
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

  const listener = (_session: unknown, event: unknown): void => {
    const candidate = event as SessionEventLike;
    if (candidate !== null && typeof candidate === "object" && typeof candidate.type === "string") {
      handle(candidate);
    }
  };
  const disposer = agentCtx.on("session/event", listener);
  return () => {
    try {
      disposer();
    } catch {
      agentCtx.off?.("session/event", listener);
    }
  };
}
