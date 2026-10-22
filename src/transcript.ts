/**
 * DSH → OpenClaw transcript writer.
 *
 * OpenClaw persists the user turn for plugin harnesses, but assistant text,
 * tool calls and tool results are owned by the harness: core never appends a
 * plugin harness's `messagesSnapshot`. Without this writer a DSH session has
 * only the user message in `chat.history` (verified against openclaw
 * 2026.10.5), so a page refresh loses every tool card and reply.
 *
 * The writer mirrors the durable DSH session surface events into OpenClaw's
 * transcript store through the public plugin SDK:
 * - `assistant/message` → one assistant message per DSH message, keeping its
 *   text and `tool-call` blocks in the same message (the shape the native
 *   harness stores for a step with preamble text plus tool calls).
 * - `tool/result` → one `toolResult` message correlated by call id.
 *
 * Writes are queued in event order and deduplicated with a stable
 * `dsh:<sessionId>:<seq>:<kind>` idempotency key. The last successfully
 * written assistant text message is reported back to the harness so the
 * attempt result can claim `assistantTranscriptOwned` and core does not
 * append the final reply a second time.
 */
import { appendSessionTranscriptMessageByIdentityStrict } from "openclaw/plugin-sdk/session-transcript-runtime";

const TOOL_RESULT_TEXT_MAX_CHARS = 64_000;

/** Durable transcript target resolved by OpenClaw for this attempt. */
export interface TranscriptSessionTarget {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  storePath?: string;
  threadId?: string | number;
}

export interface TranscriptObserverParams {
  sessionTarget?: TranscriptSessionTarget;
  sessionId: string;
  agentId?: string;
  sessionKey?: string;
  config: unknown;
  runId: string;
  provider: string;
  modelId: string;
  log: (message: string) => void;
}

/** The last assistant text message this attempt wrote to the transcript. */
export interface OwnedAssistantTranscript {
  idempotencyKey: string;
  text: string;
}

export interface TranscriptObserver {
  /** Observe one durable DSH session event (call from the event bridge). */
  observe(event: { type?: string; seq?: number; time?: number; data?: Record<string, unknown> }): void;
  /** Wait for every queued transcript write started by this attempt. */
  flush(): Promise<void>;
  /** Assistant text already persisted; absent when nothing was written. */
  ownedAssistant(): OwnedAssistantTranscript | undefined;
}

const ZERO_USAGE = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
});

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Join DSH text blocks, ignoring reasoning/images (OpenClaw stores text only). */
function textFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => {
      const record = asRecord(block);
      return record?.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("");
}

/** Parse DSH's raw JSON tool arguments into the record OpenClaw stores. */
export function argumentsRecord(value: unknown): Record<string, unknown> {
  let record: Record<string, unknown> | undefined;
  if (typeof value !== "string") {
    record = asRecord(value);
  } else {
    const text = value.trim();
    if (text === "") return {};
    try {
      record = asRecord(JSON.parse(text));
    } catch {
      return {};
    }
  }
  if (record === undefined) return {};
  // The Control UI renders a bash/exec card's title line from `args.title`
  // (falling back to `$ args.command`); it never reads `description`. Surface
  // DSH's model-generated description there so the card shows it.
  const description = record.description;
  if (typeof description === "string" && description.trim() !== "") {
    const title = record.title;
    if (typeof title !== "string" || title.trim() === "") {
      record = { ...record, title: description };
    }
  }
  return record;
}

/** DSH TokenUsage uses *Tokens field names; OpenClaw normalizes both shapes. */
export function normalizeDshUsage(raw: unknown): Record<string, unknown> {
  const usage = asRecord(raw);
  if (!usage) return { ...ZERO_USAGE };
  if (finiteNumber(usage.inputTokens) === undefined && finiteNumber(usage.outputTokens) === undefined) {
    return usage;
  }
  const input = finiteNumber(usage.inputTokens) ?? 0;
  const output = finiteNumber(usage.outputTokens) ?? 0;
  const cacheRead = finiteNumber(usage.cacheReadTokens) ?? 0;
  const cacheWrite = finiteNumber(usage.cacheWriteTokens) ?? 0;
  const reasoningTokens = finiteNumber(usage.reasoningTokens);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: finiteNumber(usage.totalTokens) ?? input + output + cacheRead + cacheWrite,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function timestampOf(event: { time?: number }): number {
  return finiteNumber(event.time) ?? Date.now();
}

function transcriptKey(sessionId: string, event: { seq?: number; data?: Record<string, unknown> }, kind: string): string {
  const seq = finiteNumber(event.seq);
  if (seq !== undefined) return `dsh:${sessionId}:${seq}:${kind}`;
  const turn = finiteNumber(event.data?.turn) ?? "?";
  const step = finiteNumber(event.data?.step) ?? "?";
  return `dsh:${sessionId}:${turn}:${step}:${kind}`;
}

/**
 * Resolve the exact transcript identity OpenClaw prepared for this attempt.
 * A mismatched target is a stale attempt; refusing to write is safer than
 * persisting into another session.
 */
function resolveTarget(params: TranscriptObserverParams): (TranscriptSessionTarget & { sessionId: string; sessionKey: string }) | undefined {
  const candidate = params.sessionTarget;
  if (!candidate?.sessionId) return undefined;
  if (candidate.sessionId !== params.sessionId) return undefined;
  if (params.sessionKey !== undefined && candidate.sessionKey !== undefined && candidate.sessionKey !== params.sessionKey) {
    return undefined;
  }
  if (params.agentId !== undefined && candidate.agentId !== undefined && candidate.agentId !== params.agentId) {
    return undefined;
  }
  const sessionKey = candidate.sessionKey ?? params.sessionKey;
  if (sessionKey === undefined || sessionKey === "") return undefined;
  return {
    ...(candidate.agentId ?? params.agentId
      ? { agentId: candidate.agentId ?? params.agentId }
      : {}),
    sessionId: candidate.sessionId,
    sessionKey,
    ...(candidate.storePath !== undefined ? { storePath: candidate.storePath } : {}),
    ...(candidate.threadId !== undefined ? { threadId: candidate.threadId } : {}),
  };
}

export function createTranscriptObserver(params: TranscriptObserverParams): TranscriptObserver {
  const target = resolveTarget(params);
  if (target === undefined) {
    params.log(`transcript persistence unavailable for session ${params.sessionId}: no matching sessionTarget`);
    return {
      observe: () => {},
      flush: async () => {},
      ownedAssistant: () => undefined,
    };
  }

  const toolNames = new Map<string, string>();
  /** Call ids already carried by a persisted assistant message. */
  const persistedToolCalls = new Set<string>();
  let queue: Promise<void> = Promise.resolve();
  let lastOwned: OwnedAssistantTranscript | undefined;

  // Append failures are the difference between a complete transcript and a
  // silently empty history: surface them in the gateway log unconditionally
  // (DEBUG only amplifies the detail).
  const warn = (message: string): void => {
    params.log(message);
    process.stderr.write(`[openclaw-plugin-dsh:transcript] ${message}\n`);
  };

  const append = (message: Record<string, unknown>): void => {
    const key = typeof message.idempotencyKey === "string" ? message.idempotencyKey : undefined;
    queue = queue.then(async () => {
      try {
        const result = await appendSessionTranscriptMessageByIdentityStrict({
          ...target,
          config: params.config,
          runId: params.runId,
          message,
        });
        if (result.kind === "rejected") {
          warn(`transcript append rejected (${key ?? "?"}): ${result.reason ?? "unknown reason"}`);
          return;
        }
        if (result.kind === "suppressed") {
          warn(`transcript append suppressed (${key ?? "?"})`);
          return;
        }
        if (key !== undefined && message.role === "assistant") {
          const text = textFromBlocks(message.content);
          if (text !== "") lastOwned = { idempotencyKey: key, text };
        }
      } catch (error) {
        warn(`transcript append failed (${key ?? "?"}): ${String(error)}`);
      }
    });
  };

  const observe = (event: { type?: string; seq?: number; time?: number; data?: Record<string, unknown> }): void => {
    const data = event.data;
    if (data === undefined) return;
    switch (event.type) {
      case "tool/call": {
        const callId = typeof data.callId === "string" ? data.callId : undefined;
        const name = typeof data.name === "string" ? data.name : undefined;
        if (callId !== undefined && name !== undefined) toolNames.set(callId, name);
        return;
      }
      case "assistant/message": {
        const message = asRecord(data.message);
        const blocks = Array.isArray(message?.content) ? message.content : [];
        const content: Array<Record<string, unknown>> = [];
        const text = textFromBlocks(blocks);
        if (text !== "") content.push({ type: "text", text });
        for (const block of blocks) {
          const call = asRecord(block);
          if (call?.type !== "tool-call") continue;
          const id = typeof call.id === "string" ? call.id : undefined;
          const name = typeof call.name === "string" ? call.name : undefined;
          if (id === undefined || name === undefined) continue;
          toolNames.set(id, name);
          persistedToolCalls.add(id);
          content.push({
            type: "toolCall",
            id,
            name,
            arguments: argumentsRecord(call.arguments),
          });
        }
        if (content.length === 0) return;
        const hasToolCalls = content.some((block) => block.type === "toolCall");
        append({
          role: "assistant",
          content,
          api: "responses",
          provider: params.provider,
          model: params.modelId,
          usage: normalizeDshUsage(data.usage),
          stopReason: data.interrupted === true ? "aborted" : hasToolCalls ? "toolUse" : "stop",
          timestamp: timestampOf(event),
          idempotencyKey: transcriptKey(target.sessionId, event, "assistant"),
        });
        return;
      }
      case "tool/result": {
        const message = asRecord(data.message);
        const callId =
          typeof message?.toolCallId === "string"
            ? message.toolCallId
            : typeof data.callId === "string"
              ? data.callId
              : undefined;
        if (callId === undefined) return;
        const name = toolNames.get(callId) ?? "tool";
        const isError = message?.isError === true || data.error !== undefined;
        const text = textFromBlocks(message?.content);
        if (!persistedToolCalls.has(callId)) {
          // The assistant message that introduced this call was never
          // observed (or DSH skipped it entirely — a pre-dispatch timeout
          // emits a result without a durable tool/call event). The native
          // harness always persists the textless assistant toolCall message
          // before its result; synthesize it so the transcript never holds an
          // orphan toolResult.
          warn(`synthesizing assistant toolCall message for orphan call ${callId} (${name})`);
          append({
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: callId,
                name,
                arguments: {},
              },
            ],
            api: "responses",
            provider: params.provider,
            model: params.modelId,
            usage: { ...ZERO_USAGE },
            stopReason: "toolUse",
            timestamp: timestampOf(event),
            idempotencyKey: transcriptKey(target.sessionId, event, "assistant-synth"),
          });
          persistedToolCalls.add(callId);
        }
        append({
          role: "toolResult",
          toolCallId: callId,
          toolName: name,
          isError,
          content: [
            {
              type: "text",
              text:
                text === ""
                  ? `${name} ${isError ? "failed" : "completed"}`
                  : text.length > TOOL_RESULT_TEXT_MAX_CHARS
                    ? `${text.slice(0, TOOL_RESULT_TEXT_MAX_CHARS)}…`
                    : text,
            },
          ],
          timestamp: timestampOf(event),
          idempotencyKey: transcriptKey(target.sessionId, event, "tool-result"),
        });
        return;
      }
      default:
        return;
    }
  };

  return {
    observe,
    flush: async () => {
      await queue;
    },
    ownedAssistant: () => lastOwned,
  };
}
