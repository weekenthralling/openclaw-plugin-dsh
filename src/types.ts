/**
 * Shared local types for openclaw-plugin-dsh.
 *
 * The plugin intentionally keeps the OpenClaw-facing surface typed through the
 * official SDK types (`openclaw/plugin-sdk/agent-harness`) and duck-types only
 * the narrow DeepSeek Harness (DSH) service slices it actually touches.
 */

/** Operator-configurable plugin settings (openclaw.json: plugins.entries.dsh.config). */
export interface DshPluginConfig {
  /** DSH home directory; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string;
  /** Optional DSH provider route override for embedded agents. */
  modelProvider?: string;
  /** Optional DSH model id override (used with modelProvider). */
  model?: string;
  /**
   * Mirror the OpenClaw-resolved provider/model/credentials into the embedded
   * DSH host (default true). Disable to keep DSH's own settings/default route.
   * Only applies when the agent is pinned to the DSH runtime by an OpenClaw
   * provider/model ref (i.e. not for `dsh/<model>` refs).
   */
  mirrorOpenClawModel?: boolean;
  /** Filesystem root for the embedded DSH sandbox workspace. */
  workspaceRoot?: string;
  /**
   * Deployment persona prefix for the embedded agents. Composed into the
   * `system-prompt` row's `personaPrefix` (the 0.2.0 spelling of the old
   * `persona` field).
   */
  persona?: string;
  /** Safety cap for one embedded DSH turn, in milliseconds. */
  turnTimeoutMs?: number;
}

/** The narrow Cordis context slice the event bridge registers on. */
export interface DshCordisContextLike {
  on(type: string, listener: (...args: any[]) => void): () => void;
  off?(type: string, listener: (...args: any[]) => void): void;
  get?(name: string): unknown;
}

/** A model selection installed into one DSH agent scope. */
export interface DshModelSelection {
  provider: string;
  model: string;
}

/**
 * Mutable selection pair consumed by DSH's `installModelSelection` (the
 * package does not re-export the type from its entry point).
 */
export interface DshModelSelectionRef {
  /** Model selected for the next step that enters prompt assembly. */
  current: DshModelSelection | undefined;
  /** Selection captured when the current step entered prompt assembly. */
  assembled: DshModelSelection | undefined;
}

/** The narrow DSH Agent slice used by the harness (the 0.2.0 runtime face). */
export interface DshAgentLike {
  readonly id: unknown;
  readonly ctx: DshCordisContextLike;
  readonly session: unknown;
  followup(message: unknown): void;
  inject?(message: unknown): void;
  whenIdle(): Promise<void>;
  cancel(cause: { kind: string; reason?: string }): void;
}

/** Handle returned by the DSH agent registry (agent plus its disposer). */
export interface DshAgentHandleLike {
  agent: DshAgentLike;
  dispose(): Promise<void>;
}

/** The narrow DSH agent-registry slice used by the harness. */
export interface DshAgentsRegistryLike {
  create(options: {
    sessionId: unknown;
    meta?: { cwd?: string };
    agentOptions?: { provider?: string; model?: string };
    setup?: (agentCtx: DshCordisContextLike) => void | Promise<void>;
    signal?: AbortSignal;
  }): Promise<DshAgentHandleLike>;
  resume(options: {
    resumeSessionId: unknown;
    agentOptions?: { provider?: string; model?: string };
    setup?: (agentCtx: DshCordisContextLike) => void | Promise<void>;
    signal?: AbortSignal;
  }): Promise<DshAgentHandleLike>;
  get(id: unknown): DshAgentLike | undefined;
}

/** The narrow DSH sessions service slice used by the harness. */
export interface DshSessionsLike {
  flush(session: unknown): Promise<boolean>;
}

/** A persisted-session snapshot entry, as returned by the persistence `stat`. */
export interface DshSessionSnapshotLike {
  header?: {
    meta?: {
      cwd?: string;
    };
  };
}

/** The narrow DSH persistence slice used to detect resumable sessions. */
export interface DshPersistenceLike {
  stat(id: unknown, options?: { signal?: AbortSignal }): Promise<DshSessionSnapshotLike | undefined>;
}

/** The narrow DSH default-model selection slice used by the harness. */
export interface DshAgentDefaultModelLike {
  currentSelection(): { provider: string; model: string } | undefined;
}

/** Everything the harness keeps for the embedded DSH host. */
export interface DshHost {
  /** Root Cordis context of the booted DSH tree (duck-typed). */
  ctx: DshCordisContextLike & {
    get(name: string): unknown;
    dispose?(): Promise<void> | void;
  };
  agents: DshAgentsRegistryLike;
  sessions: DshSessionsLike;
  agentDefaultModel: DshAgentDefaultModelLike;
  sessionPersistence: DshPersistenceLike;
  dispose(): Promise<void>;
}

/** Serialized-turn result facts collected from DSH session events. */
export interface TurnFacts {
  /** Assembled per-step assistant texts (durable surface events). */
  assistantTexts: string[];
  /** Joined live text deltas, fallback when no assembled message arrived. */
  deltaText: string;
  /** Live reasoning deltas joined. */
  reasoningText: string;
  /** Tool-call bookkeeping for the attempt result. */
  toolMetas: Array<{ toolName: string; toolCallId?: string; isError?: boolean; meta?: string }>;
  /** Latest turn-end reason, if observed. */
  turnEndReason: { kind: string } | undefined;
  /** Latest usage observed on an assembled assistant message. */
  usage: unknown;
  /** Whether any assistant output started this turn. */
  started: boolean;
  /** Whether any tool call was observed this turn. */
  toolActivity: boolean;
  /** Completed tool results observed this turn. */
  completedToolResults: number;
}

/**
 * One live assistant-text snapshot published for UI consumers. `text` is
 * cumulative within the assistant message being streamed; `delta` is the
 * chunk that produced the snapshot. A snapshot with `replace` restarts the
 * message content (a retried model call), so consumers must discard the
 * previous text for `itemId`.
 */
export interface AssistantStreamUpdate {
  /** Stable identity of the assistant message currently streaming. */
  itemId: string;
  /** Cumulative text of that assistant message so far. */
  text: string;
  /** The chunk text that produced this snapshot ("" on a replace). */
  delta: string;
  /** Restart the streamed content instead of appending to it. */
  replace?: true;
}

/**
 * One live tool-call update for the OpenClaw agent event bus. Emitted as
 * `{stream: "tool", data: {...}}`; the Control UI builds its tool cards from
 * the call id, phase, name, args and result carried here.
 */
export interface ToolStreamUpdate {
  /** `start` when the call is dispatched, `result` when it settles. */
  phase: "start" | "result";
  /** DSH call id; the UI keys its tool card by this value. */
  toolCallId: string;
  /** Tool name as reported by DSH. */
  name: string;
  /** Parsed JSON arguments (start only). */
  args?: unknown;
  /** Text result (result only). */
  result?: string;
  /** Whether the tool invocation failed (result only). */
  isError?: boolean;
  /** Optional tool-result metadata reported by DSH (result only). */
  meta?: unknown;
}

/** Callbacks the event bridge forwards OpenClaw streaming into. */
export interface BridgeCallbacks {
  /** OpenClaw 2026.10.4: returning true cancels the attempt delivery. */
  onPartialReply(payload: { delta?: string; text?: string; replace?: true }): boolean | void | Promise<boolean | void>;
  onReasoningStream?(payload: { text: string; isReasoning?: boolean }): void | Promise<void>;
  onAssistantMessageStart?(): void | Promise<void>;
  onToolResult?(payload: { text: string }): void | Promise<void>;
  /**
   * Live tool-call updates for the OpenClaw agent event bus. The Control UI
   * builds tool cards from these events; `onToolResult` only feeds channel
   * progress text.
   */
  onToolEvent?(payload: ToolStreamUpdate): void;
  /**
   * Live assistant-text snapshots for the OpenClaw agent event bus. The
   * Control UI's streaming text is driven by these events, not by
   * `onPartialReply` (which feeds channel presentation instead).
   */
  onAssistantStream?(payload: AssistantStreamUpdate): void;
}
