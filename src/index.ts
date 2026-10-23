/**
 * openclaw-plugin-dsh entry point.
 *
 * Registers the `dsh` agent harness so OpenClaw routes agent turns through the
 * embedded DeepSeek Harness when the resolved provider is `dsh`
 * (e.g. `agents.defaults.model: "dsh/deepseek-v4-pro"`) or when any
 * provider/model entry pins `agentRuntime.id: "dsh"`.
 *
 * Why this entry is SDK-free: OpenClaw loads installed plugin entries with a
 * native require(ESM) interop while its own dist graph is still cold; a
 * top-level SDK import is aliased into that cold graph and can trip Node's
 * "not yet fully loaded" assertion during startup. The entry therefore keeps
 * zero top-level imports (also matching the SDK guidance that entry
 * evaluation must stay lightweight) and lazily loads the real harness
 * implementation on the first harness call, when the host graph is warm.
 *
 * Operator config (optional, all fields default):
 *   plugins.entries.dsh.config = {
 *     dshHome, modelProvider, model, workspaceRoot, persona, turnTimeoutMs
 *   }
 */

const HARNESS_ID = "dsh";

type HarnessImpl = {
  supports(ctx: unknown): unknown;
  runAttempt(params: unknown): Promise<unknown>;
  reset(params: unknown): Promise<void>;
  compact(params: unknown): Promise<unknown>;
  dispose(): Promise<void>;
};

let implPromise: Promise<HarnessImpl> | undefined;
/** True once a turn asked for the real harness (reset/compact only matter then). */
let used = false;

/** Lazily import the real harness module (first call happens post-startup). */
function impl(): Promise<HarnessImpl> {
  used = true;
  implPromise ??= import("./harness.js")
    .then((module) => module.createDshHarness() as unknown as HarnessImpl)
    .catch((error: unknown) => {
      // Do not poison the plugin with a transient module-load failure.
      implPromise = undefined;
      throw error;
    });
  return implPromise;
}

/** Stable, SDK-free wrapper harness registered synchronously at load time. */
const harness = {
  id: HARNESS_ID,
  label: "DeepSeek Harness (DSH) agent harness",
  // Preflight (harness selection/availability) reads the REGISTERED object —
  // this wrapper — before any runAttempt loads the lazy implementation, so
  // the tool-policy capability must be declared here as well. Enforcement
  // itself lives in the implementation (see tool-policy.ts).
  conversationToolPolicySupport: "exact",
  conversationToolPolicySafeDenyTools: [
    "exec",
    "process",
    "read",
    "write",
    "edit",
    "ls",
    "web_search",
    "web_fetch",
  ],

  supports(ctx: { requestedRuntime?: string; provider?: string }): unknown {
    if (ctx?.requestedRuntime === HARNESS_ID) {
      return { supported: true, priority: 200, reason: "explicitly pinned dsh runtime" };
    }
    if (ctx?.provider === HARNESS_ID) {
      return { supported: true, priority: 100, reason: "dsh provider ref" };
    }
    return { supported: false, reason: `provider ${ctx?.provider ?? "unknown"} is not ${HARNESS_ID}` };
  },

  async runAttempt(params: unknown): Promise<unknown> {
    return (await impl()).runAttempt(params);
  },

  async reset(params: unknown): Promise<void> {
    // A session reset for a harness that never ran must not pull the whole
    // DSH dependency tree into the gateway just to find nothing to dispose.
    if (!used) return;
    return (await impl()).reset(params);
  },

  async compact(params: unknown): Promise<unknown> {
    if (!used) return undefined;
    return (await impl()).compact(params);
  },

  async dispose(): Promise<void> {
    // OpenClaw calls this on every unload/reload, including plugins that were
    // loaded but never used. Do not lazily import the harness just to dispose
    // an empty host (that import can fail or overrun the retirement budget).
    if (implPromise === undefined) return;
    const implementation = await implPromise.catch(() => undefined);
    await implementation?.dispose();
  },
};

/**
 * Synthetic `dsh` provider. The harness owns all transport: no HTTP model API
 * and no OpenClaw credentials exist for this provider, so the catalog is a
 * pass-through that accepts any `dsh/<model>` ref and resolves it to inert
 * runtime metadata. The actual model choice belongs to the embedded DeepSeek
 * Harness (its own settings.yaml / agent-default-model route).
 */
const dshProvider = {
  id: HARNESS_ID,
  label: "DeepSeek Harness (DSH)",
  auth: [],
  resolveDynamicModel(ctx: { provider?: string; modelId?: string }): unknown {
    if (!ctx || ctx.provider !== HARNESS_ID) return null;
    const modelId =
      typeof ctx.modelId === "string" && ctx.modelId.trim() !== "" ? ctx.modelId : "deepseek-v4-pro";
    return {
      id: modelId,
      name: modelId,
      api: "openai-completions",
      provider: HARNESS_ID,
      baseUrl: "",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    };
  },
};

export default {
  id: HARNESS_ID,
  name: "DeepSeek Harness (DSH)",
  description:
    "Runs OpenClaw agent turns through an embedded DeepSeek Harness agent with its own tools, sessions, compaction, and goals.",
  register(api: {
    registerProvider?(value: unknown): void;
    registerAgentHarness(value: unknown): void;
  }) {
    api.registerProvider?.(dshProvider);
    api.registerAgentHarness(harness);
  },
};
