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
  /** Filesystem root for the embedded DSH sandbox workspace. */
  workspaceRoot?: string;
  /** System-prompt persona override. */
  persona?: string;
  /** Safety cap for one embedded DSH turn, in milliseconds. */
  turnTimeoutMs?: number;
  /**
   * DSH agent preset composed into every embedded agent (its tools, persona,
   * prompt sections). Shipped presets: standard (default), code, cordis,
   * minimal — plus any preset authored under $DSH_HOME/.agent-presets/<id>/.
   */
  agentPreset?: string;
  /**
   * Mount the dynamic Cordis plugin runtime (cordis_define/cordis_run/… tools
   * via the cordis preset). Defaults to true.
   */
  allowDynamicPlugins?: boolean;
}

/** The narrow Cordis context slice the event bridge registers on. */
export interface DshCordisContextLike {
  on(type: string, listener: (...args: any[]) => void): () => void;
  off?(type: string, listener: (...args: any[]) => void): void;
  get?(name: string): unknown;
}

/** The narrow DSH Agent slice used by the harness. */
export interface DshAgentLike {
  readonly id: unknown;
  readonly ctx: DshCordisContextLike;
  readonly session: {
    events: readonly any[];
    seq: number;
  };
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
    meta?: { cwd?: string; agentPreset?: string };
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
  flush(session: { events: readonly any[]; seq: number }): Promise<boolean>;
}

/** The narrow DSH persistence slice used to detect resumable sessions. */
export interface DshPersistenceLike {
  inspect(id: unknown, signal?: AbortSignal): Promise<unknown>;
}

/** The narrow DSH default-model selection slice used by the harness. */
export interface DshAgentDefaultModelLike {
  currentSelection(): { provider: string; model: string } | undefined;
}

/** The narrow DSH agent-presets service slice used by the harness. */
export interface DshAgentPresetsLike {
  resolve(id?: string): Promise<{ id: string }>;
  mount(agentCtx: DshCordisContextLike, id: string): Promise<void>;
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
  /** Present whenever the agent-presets row mounted (it always does). */
  agentPresets?: DshAgentPresetsLike;
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
  toolMetas: Array<{ toolName: string; meta?: string }>;
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

/** Callbacks the event bridge forwards OpenClaw streaming into. */
export interface BridgeCallbacks {
  onPartialReply(payload: { delta?: string; text?: string; replace?: true }): void | Promise<void>;
  onReasoningStream?(payload: { text: string; isReasoning?: boolean }): void | Promise<void>;
  onAssistantMessageStart?(): void | Promise<void>;
  onToolResult?(payload: { text: string }): void | Promise<void>;
}
