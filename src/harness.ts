/**
 * The `dsh` OpenClaw agent harness: each prepared OpenClaw agent turn runs
 * through the embedded DeepSeek Harness agent bound to the OpenClaw session.
 *
 * Contract notes (verified against openclaw 2026.10.5 dist typings):
 * - Implements AgentHarnessV2: core always supplies hostCapabilities to
 *   plugin harnesses, so the versioned attempt params are the honest contract.
 * - Selection: `auto` policy asks supports() per provider/model; a pinned
 *   `agentRuntime.id: "dsh"` forces this harness by id and still consults
 *   supports(). Claiming provider `dsh` covers `dsh/<model>` refs.
 * - The attempt result is normalized by core
 *   (normalizeEmbeddedRunAttemptResult), so array fields have defaults; the
 *   required scalars are provided explicitly below.
 * - A thrown error inside runAttempt surfaces as a hard run failure with no
 *   embedded fallback, so every DSH failure is converted into a structured
 *   promptError result instead of escaping.
 *
 * DSH 0.2.0 note: turn failures arrive as `turn/end` with
 * `reason.kind === "error"` carrying the structured `LlmFailure` in
 * `reason.error` (message/code facts, flattened to UNKNOWN otherwise).
 */
import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness";
import type { AgentHarnessAttemptResult } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  awaitAgentEndSideEffects,
  classifyAgentHarnessTerminalOutcome,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import {
  DEFAULT_TURN_TIMEOUT_MS,
  disposeAgent,
  disposeHost,
  ensureHost,
  enqueueTurn,
  getOrCreateAgent,
  resolveAgentOptions,
  selectAgentModel,
} from "./host.js";
import { attemptSelectionFor, loadModelMirror } from "./openclaw-model.js";
import { attachEventBridge, createTurnFacts } from "./events.js";
import type { DshPluginConfig } from "./types.js";

const HARNESS_ID = "dsh";

function log(message: string): void {
  if (process.env.OPENCLAW_DSH_DEBUG === "1") {
    process.stderr.write(`[openclaw-plugin-dsh] ${message}\n`);
  }
}

/** Plugin config lives at plugins.entries.dsh.config of the live global config. */
function resolvePluginConfig(config: unknown): DshPluginConfig {
  const candidate = config as
    | { plugins?: { entries?: Record<string, { config?: Record<string, unknown> }> } }
    | undefined;
  const raw = candidate?.plugins?.entries?.dsh?.config;
  return raw !== null && typeof raw === "object" ? (raw as DshPluginConfig) : {};
}

/** Build the normalized attempt result OpenClaw consumes after runAttempt. */
function buildAttemptResult(params: {
  sessionId: string;
  sessionFile: string;
  aborted: boolean;
  externalAbort: boolean;
  timedOut: boolean;
  promptError: unknown;
  promptErrorSource: "prompt" | "compaction" | "precheck" | "hook:before_agent_run" | null;
  assistantTexts: string[];
  toolMetas: Array<{ toolName: string; meta?: string }>;
  toolActivity: boolean;
  completedToolResults: number;
  usage: unknown;
  provider: string;
  modelId: string;
  classification?: "empty" | "reasoning-only" | "planning-only";
}): AgentHarnessAttemptResult {
  const lastText = params.assistantTexts[params.assistantTexts.length - 1] ?? "";
  const lastAssistant =
    lastText === ""
      ? undefined
      : {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: lastText }],
          api: "responses",
          provider: params.provider,
          model: params.modelId,
          stopReason: params.promptError === null ? ("stop" as const) : ("error" as const),
          timestamp: Date.now(),
          ...(params.usage !== undefined ? { usage: params.usage } : {}),
        };
  return {
    aborted: params.aborted,
    externalAbort: params.externalAbort,
    timedOut: params.timedOut,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    promptError: params.promptError,
    promptErrorSource: params.promptErrorSource,
    sessionIdUsed: params.sessionId,
    sessionFileUsed: params.sessionFile,
    assistantTexts: params.assistantTexts,
    toolMetas: params.toolMetas,
    lastAssistant,
    messagesSnapshot: [],
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    didSendViaMessagingTool: false,
    cloudCodeAssistFormatError: false,
    itemLifecycle: {
      startedCount: 0,
      completedCount: params.completedToolResults,
      activeCount: 0,
    },
    replayMetadata: {
      hadPotentialSideEffects: params.toolActivity,
      replaySafe: !params.toolActivity,
    },
    ...(params.usage !== undefined ? { attemptUsage: params.usage } : {}),
    ...(params.classification !== undefined ? { agentHarnessResultClassification: params.classification } : {}),
  } as unknown as AgentHarnessAttemptResult;
}

function failedAttemptResult(params: {
  sessionId: string;
  sessionFile: string;
  provider: string;
  modelId: string;
  error: unknown;
}): AgentHarnessAttemptResult {
  return buildAttemptResult({
    sessionId: params.sessionId,
    sessionFile: params.sessionFile,
    aborted: false,
    externalAbort: false,
    timedOut: false,
    promptError: params.error,
    promptErrorSource: "prompt",
    assistantTexts: [],
    toolMetas: [],
    toolActivity: false,
    completedToolResults: 0,
    usage: undefined,
    provider: params.provider,
    modelId: params.modelId,
  });
}

export function createDshHarness(): AgentHarnessV2 {
  return {
    id: HARNESS_ID,
    label: "DeepSeek Harness (DSH) agent harness",

    supports(ctx) {
      if (ctx.requestedRuntime === HARNESS_ID) {
        return { supported: true, priority: 200, reason: "explicitly pinned dsh runtime" };
      }
      if (ctx.provider === HARNESS_ID) {
        return { supported: true, priority: 100, reason: "dsh provider ref" };
      }
      return { supported: false, reason: `provider ${ctx.provider} is not ${HARNESS_ID}` };
    },

    async runAttempt(params) {
      const started = Date.now();
      const provider = params.provider;
      const modelId = params.modelId;
      try {
        const config = resolvePluginConfig(params.config);
        params.onExecutionStarted?.();

        // Already aborted before the turn opened: return a clean abort result.
        if (params.abortSignal?.aborted) {
          return buildAttemptResult({
            sessionId: params.sessionId,
            sessionFile: params.sessionFile,
            aborted: true,
            externalAbort: true,
            timedOut: false,
            promptError: null,
            promptErrorSource: null,
            assistantTexts: [],
            toolMetas: [],
            toolActivity: false,
            completedToolResults: 0,
            usage: undefined,
            provider,
            modelId,
          });
        }

        const mirror =
          config.mirrorOpenClawModel === false ? undefined : await loadModelMirror(params);
        const host = await ensureHost(config, mirror);
        // The mirror is boot-scoped (cached), so resolve this attempt's exact
        // selection independently: model fallbacks can change it per attempt.
        const attemptSelection =
          mirror !== undefined && provider !== HARNESS_ID && modelId !== ""
            ? attemptSelectionFor(mirror, provider, modelId)
            : undefined;
        const agentOptions = resolveAgentOptions(host, config, attemptSelection);
        const entry = await getOrCreateAgent(host, params.sessionId, params.workspaceDir, agentOptions, config);
        const agent = entry.handle.agent;

        return await enqueueTurn(entry, async () => {
          const facts = createTurnFacts();
          let externalAbort = false;
          let timedOut = false;
          let attemptError: unknown = null;

          const detach = attachEventBridge(agent.ctx, {
            onPartialReply: (payload) => params.onPartialReply?.(payload),
            onReasoningStream: (payload) => params.onReasoningStream?.({ ...payload, text: payload.text }),
            onAssistantMessageStart: () => params.onAssistantMessageStart?.(),
            onToolResult: (payload) => params.onToolResult?.(payload),
          }, facts);

          const abortListener = (): void => {
            externalAbort = true;
            agent.cancel({ kind: "user" });
          };
          params.abortSignal?.addEventListener("abort", abortListener);

          const timeoutMs = config.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
          const timeoutHandle = setTimeout(() => {
            timedOut = true;
            log(`turn timeout after ${timeoutMs}ms for OpenClaw session ${params.sessionId}`);
            agent.cancel({ kind: "hook", reason: "openclaw-turn-timeout" });
          }, timeoutMs);
          timeoutHandle.unref?.();

          try {
            // Apply the route OpenClaw prepared for this attempt. Assigning the
            // mutable selection takes effect when the next step enters prompt
            // assembly; an in-flight step keeps its captured provider/model.
            selectAgentModel(entry, agentOptions);
            if (params.extraSystemPrompt && params.extraSystemPrompt.trim() !== "") {
              agent.inject?.(createUserMessage({
                content: [{ type: "text", text: params.extraSystemPrompt }],
                source: { kind: "user" },
              }));
            }
            agent.followup(createUserMessage({
              content: [{ type: "text", text: params.prompt }],
              source: { kind: "user" },
            }));
            await agent.whenIdle();
          } catch (error) {
            attemptError = error;
            log(`DSH turn failed: ${String(error)}`);
          } finally {
            clearTimeout(timeoutHandle);
            params.abortSignal?.removeEventListener("abort", abortListener);
            try {
              await host.sessions.flush(agent.session);
            } catch (error) {
              log(`session flush failed: ${String(error)}`);
            }
            detach();
          }

          // A DSH turn that closed with a structured error (e.g. credential or
          // provider failure) becomes the attempt's promptError so OpenClaw
          // surfaces the real cause instead of a generic empty-response text.
          if (attemptError === null && facts.turnEndReason?.kind === "error") {
            const failure = facts.turnEndReason as unknown as {
              error?: { message?: string; code?: string };
            };
            attemptError = {
              message:
                typeof failure.error?.message === "string" && failure.error.message !== ""
                  ? failure.error.message
                  : "DeepSeek Harness turn failed",
              code: typeof failure.error?.code === "string" ? failure.error.code : "DSH_TURN_ERROR",
            };
          }

          const assistantTexts = facts.assistantTexts.length > 0
            ? facts.assistantTexts
            : facts.deltaText.trim() !== "" ? [facts.deltaText] : [];

          const classification = classifyAgentHarnessTerminalOutcome({
            turnCompleted: true,
            promptError: attemptError,
            assistantTexts,
            reasoningText: facts.reasoningText,
          });

          const result = buildAttemptResult({
            sessionId: params.sessionId,
            sessionFile: params.sessionFile,
            aborted: externalAbort,
            externalAbort,
            timedOut,
            promptError: attemptError,
            promptErrorSource: attemptError === null ? null : "prompt",
            assistantTexts,
            toolMetas: facts.toolMetas,
            toolActivity: facts.toolActivity,
            completedToolResults: facts.completedToolResults,
            usage: facts.usage,
            provider,
            modelId,
            classification,
          });

          // Dispatch the portable agent_end hook and research capture without
          // letting their failures alter the attempt result.
          try {
            await awaitAgentEndSideEffects({
              event: {
                messages: [
                  {
                    role: "assistant",
                    content: [{ type: "text", text: assistantTexts[assistantTexts.length - 1] ?? "" }],
                    timestamp: Date.now(),
                  },
                ],
                success: attemptError === null && !timedOut && !externalAbort,
                durationMs: Date.now() - started,
              },
              ctx: {
                runId: params.runId,
                agentId: params.agentId,
                sessionKey: params.sessionKey,
                sessionId: params.sessionId,
                workspaceDir: params.workspaceDir,
                trigger: params.trigger,
                config: params.config,
              },
            });
          } catch (error) {
            log(`agent-end side effects failed: ${String(error)}`);
          }
          return result;
        });
      } catch (error) {
        log(`attempt preparation failed: ${String(error)}`);
        return failedAttemptResult({
          sessionId: params.sessionId,
          sessionFile: params.sessionFile,
          provider,
          modelId,
          error,
        });
      }
    },

    async reset(params) {
      if (params.sessionId) {
        await disposeAgent(params.sessionId);
      }
    },

    async compact() {
      // The embedded DSH runtime owns compaction of its own sessions
      // (dsh-compaction-basic). OpenClaw-side context-engine compaction does
      // not apply to DSH sessions; report nothing to compact.
      return undefined;
    },

    async dispose() {
      await disposeHost();
    },
  };
}
