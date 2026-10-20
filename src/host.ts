/**
 * Embedded DeepSeek Harness (DSH) host: boots one DSH core tree inside the
 * OpenClaw gateway process and hands out per-OpenClaw-session DSH Agents.
 *
 * Boot mechanics (verified against @deepseek-ai/dsh-app-boot 0.2.0-rc.2):
 * - The plugin ships a DSH profile template under ../config (package.json
 *   declaring dsh.profile.bundles plus an empty cordis.yml and a static
 *   cordis.patch.yml overlay).
 * - boot(binName, absoluteConfigPath, patches, prepare, bareModuleBaseUrl)
 *   mounts that cordis.yml with an explicit patch list; bundle patches are
 *   loaded with loadOverlayPatches (required files), the static overlay with
 *   loadOptionalPatches (absent file means "no layer", so the undefined return
 *   is normalized to an empty layer), and operator-config rows are appended
 *   last so they always win.
 * - bareModuleBaseUrl points at the plugin's own node_modules so bare package
 *   rows (@deepseek-ai/dsh-*) resolve from the plugin dependency tree.
 * - $DSH_HOME is resolved at module import time, so it must be pinned on
 *   process.env before the first dynamic import of dsh-app-boot.
 *
 * 0.2.0 service surface (the base bundle mounts all of these rows):
 * - `agents` (AgentRegistry) — create/resume via the agent-loop factory.
 * - `sessions` (SessionStore) — flush(session) is the durability entry point.
 * - `sessionPersistence` (JSONL backend) — stat(id) detects resumable logs.
 * - `agentDefaultModel` — default model selection read at agent creation.
 */
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createLaunchEnvironmentSnapshot } from "@deepseek-ai/dsh-launch-environment";
import type {
  DshAgentHandleLike,
  DshHost,
  DshPluginConfig,
  DshModelSelection,
  DshModelSelectionRef,
} from "./types.js";
import { resetModelMirror, type OpenClawModelMirror } from "./openclaw-model.js";

const BIN_NAME = "openclaw-plugin-dsh";

/** The persona used when the operator does not override it. */
export const DEFAULT_PERSONA =
  "You are the DeepSeek Harness agent embedded inside OpenClaw. Your working directory is {{cwd}}.";

const DEFAULT_TURN_TIMEOUT_MS = 900_000;

/**
 * OpenClaw gives a retired plugin instance 5s to drain before it force-retires
 * it, and a forced retirement can leave the gateway's prepared model runtime
 * pointing at a dead instance (every later health/heartbeat call then fails
 * with "Plugin dsh was reloaded or disabled"). Keep our teardown well inside
 * that budget: cancel live agents first, then bound each dispose await.
 */
const AGENT_DISPOSE_TIMEOUT_MS = 1_500;
const HOST_DISPOSE_TIMEOUT_MS = 1_500;

let hostPromise: Promise<DshHost> | undefined;
let disposed = false;

/** Per-OpenClaw-session DSH agent bookkeeping. */
interface AgentEntry {
  dshId: string;
  cwd: string;
  handle: DshAgentHandleLike;
  /** Live marker DSH reads when assembling the next step's request. */
  selection: DshModelSelectionRef;
  /** Serializes turns against one DSH agent (OpenClaw lanes are already serial). */
  turn: Promise<unknown>;
}

const agentEntries = new Map<string, AgentEntry>();

function log(message: string): void {
  // OpenClaw's plugin logger is not available at this layer; the gateway
  // stderr prefix keeps these lines greppable without noise on success paths.
  if (process.env.OPENCLAW_DSH_DEBUG === "1") {
    process.stderr.write(`[openclaw-plugin-dsh] ${message}\n`);
  }
}

/** Bound one teardown await so a stuck agent cannot blow the unload budget. */
function withDisposeTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Map an OpenClaw session id onto a stable, filesystem-safe DSH session id. */
export function toDshSessionId(openclawSessionId: string): string {
  const sanitized = openclawSessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return `oc-${sanitized || "session"}`;
}

interface BootedServices {
  ctx: DshHost["ctx"];
  agents: DshHost["agents"];
  sessions: DshHost["sessions"];
  agentDefaultModel: DshHost["agentDefaultModel"];
  sessionPersistence: DshHost["sessionPersistence"];
}

async function bootOnce(
  config: DshPluginConfig,
  mirror: OpenClawModelMirror | undefined,
): Promise<DshHost> {
  // $DSH_HOME is read by dsh-home-paths at dsh-app-boot module load time, so
  // pin it before the first import. Default: the machine's shared ~/.dsh,
  // which is what makes settings.yaml credentials and DEEPSEEK_API_KEY work
  // out of the box for users who already run the DeepSeek Harness.
  if (config.dshHome && config.dshHome.trim() !== "") {
    process.env.DSH_HOME = config.dshHome;
  }

  const bootMod = await import("@deepseek-ai/dsh-app-boot");
  const profileDir = fileURLToPath(new URL("../config/", import.meta.url));
  const pluginPackageJson = fileURLToPath(new URL("../package.json", import.meta.url));
  const cordisYml = join(profileDir, "cordis.yml");

  const require = createRequire(import.meta.url);
  const basePackageJson = require.resolve("@deepseek-ai/dsh-base/package.json");
  const nodeModulesDir = dirname(dirname(basePackageJson));
  const bareModuleBaseUrl = pathToFileURL(join(nodeModulesDir, "/")).href;

  const manifest = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8")) as {
    dsh?: { profile?: { bundles?: string[] } };
  };
  const bundles = manifest.dsh?.profile?.bundles ?? [];

  // Layer 1: each bundle's declared cordis.patch.yml.
  const layers: Array<Record<string, unknown>> = [];
  for (const bundleName of bundles) {
    const packageDir = bootMod.resolveBundleDir(BIN_NAME, bundleName, pluginPackageJson, profileDir) as string;
    const bundleManifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      dsh?: { bundle?: { patch?: string } };
    };
    const declared = bundleManifest.dsh?.bundle?.patch;
    if (declared === undefined) {
      throw new Error(`${BIN_NAME}: bundle ${bundleName} declares no dsh.bundle patch`);
    }
    const bundlePatches = bootMod.loadOverlayPatches(BIN_NAME, join(packageDir, declared)) as Record<string, unknown>[];
    layers.push(...bundlePatches);
  }

  // Layer 2: this plugin's static overlay. loadOptionalPatches returns
  // undefined when the file is absent ("no layer" by contract).
  const staticPatches =
    (bootMod.loadOptionalPatches(BIN_NAME, join(profileDir, "cordis.patch.yml")) as
      | Record<string, unknown>[]
      | undefined) ?? [];
  layers.push(...staticPatches);

  // Layer 3: operator-config rows, applied last so they always win.
  // The 0.2.0 system-prompt row spells the deployment persona `personaPrefix`.
  layers.push(
    {
      id: "system-prompt",
      config: { personaPrefix: config.persona ?? DEFAULT_PERSONA },
    },
    {
      id: "sandbox-policy",
      config: {
        mode: process.env.DSH_PERMISSION_MODE ?? "workspace-write",
        workspaceRoot: config.workspaceRoot ?? homedir(),
      },
    },
  );
  if (config.modelProvider && config.modelProvider.trim() !== "" && config.model) {
    layers.push({
      id: "agent-default-model",
      config: { provider: config.modelProvider, model: config.model },
    });
  }

  // Layer 4: the OpenClaw-prepared model routes. The `llm-pi-ai` adapter is
  // mounted dormant by the base bundle and registers exactly the routes we
  // declare here; `agent-default-model` only seeds DSH's creation default,
  // while each attempt still installs its own exact selection (see below).
  if (mirror !== undefined && Object.keys(mirror.profiles).length > 0) {
    layers.push({
      id: "llm-pi-ai",
      config: { providers: mirror.profiles },
    });
    if (mirror.selection !== undefined) {
      layers.push({
        id: "agent-default-model",
        config: mirror.selection,
      });
    }
  }

  log(
    `booting embedded DSH host: profile=${profileDir} dshHome=${process.env.DSH_HOME ?? "<default>"} ` +
      `bundles=${bundles.join(",")} ` +
      `modelRoutes=${Object.keys(mirror?.profiles ?? {}).join(",") || "<none>"}`,
  );

  // dsh-app-boot has no launcher here, so no `launchEnvironment` service is
  // mounted by default and `launchEnvironmentOf(ctx)` falls back to reading
  // the *live* process.env on every call. Publish the resolved keys only for
  // the boot window, capture them in an explicit launch-environment snapshot,
  // and mount that snapshot through the `prepare` hook. DSH's credentials and
  // pi-ai adapters then resolve keys from the frozen snapshot, while child
  // processes spawned by DSH tools never inherit the values.
  const stagedEnvironment = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(mirror?.environment ?? {})) {
    stagedEnvironment.set(name, process.env[name]);
    process.env[name] = value;
  }
  let ctx: BootedServices["ctx"];
  try {
    const launchEnvironment = createLaunchEnvironmentSnapshot([
      {
        source: "process",
        values: Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
      },
    ]);
    ctx = (await bootMod.boot(
      BIN_NAME,
      cordisYml,
      layers,
      (rootCtx: { provide(name: string, value: unknown): void }) => {
        rootCtx.provide("launchEnvironment", launchEnvironment);
      },
      bareModuleBaseUrl,
    )) as unknown as BootedServices["ctx"];
  } finally {
    for (const [name, previous] of stagedEnvironment) {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  }

  const services: BootedServices = {
    ctx,
    agents: ctx.get("agents") as BootedServices["agents"],
    sessions: ctx.get("sessions") as BootedServices["sessions"],
    agentDefaultModel: ctx.get("agentDefaultModel") as BootedServices["agentDefaultModel"],
    sessionPersistence: ctx.get("sessionPersistence") as BootedServices["sessionPersistence"],
  };
  if (!services.agents || !services.sessions || !services.agentDefaultModel) {
    throw new Error(`${BIN_NAME}: booted DSH tree is missing core services (agents/sessions/agentDefaultModel)`);
  }
  log("embedded DSH host booted");
  return {
    ...services,
    async dispose(): Promise<void> {
      log("disposing embedded DSH host");
      await (services.ctx.dispose?.() ?? (services.ctx as { fiber?: { dispose(): Promise<void> } }).fiber?.dispose?.());
    },
  };
}

/** Boot (once) and return the shared embedded DSH host. */
export async function ensureHost(
  config: DshPluginConfig,
  mirror?: OpenClawModelMirror,
): Promise<DshHost> {
  if (disposed) throw new Error(`${BIN_NAME}: host was disposed`);
  hostPromise ??= bootOnce(config, mirror).catch((error: unknown) => {
    hostPromise = undefined;
    throw error;
  });
  return hostPromise;
}

/**
 * Resolve the DSH agent options for one OpenClaw session. An attempt carrying
 * a real OpenClaw provider route always wins: the embedded agent must run the
 * exact provider/model OpenClaw prepared, not a DSH-side default.
 */
export function resolveAgentOptions(
  host: DshHost,
  config: DshPluginConfig,
  attemptSelection?: DshModelSelection,
): DshModelSelection | undefined {
  if (attemptSelection !== undefined) {
    return { ...attemptSelection };
  }
  if (config.modelProvider && config.modelProvider.trim() !== "" && config.model) {
    return { provider: config.modelProvider, model: config.model };
  }
  const selection = host.agentDefaultModel.currentSelection();
  if (selection === undefined) return undefined;
  return { provider: selection.provider, model: selection.model };
}

/**
 * Get-or-create the DSH Agent bound to one OpenClaw session. A persisted DSH
 * session (surviving gateway restarts via $DSH_HOME/sessions) is resumed;
 * otherwise a fresh agent is created with the OpenClaw workspace as cwd.
 */
export async function getOrCreateAgent(
  host: DshHost,
  openclawSessionId: string,
  cwd: string,
  agentOptions: DshModelSelection | undefined,
  _config: DshPluginConfig,
): Promise<AgentEntry> {
  const dshId = toDshSessionId(openclawSessionId);
  const existing = agentEntries.get(dshId);
  if (existing !== undefined) return existing;

  // One mutable selection owned by this plugin, installed into the agent
  // scope. Updating `.current` applies the OpenClaw-prepared route to the next
  // step (including model fallbacks), without recreating the DSH agent.
  const selection: DshModelSelectionRef = {
    current: agentOptions === undefined ? undefined : { ...agentOptions },
    assembled: undefined,
  };
  const makeSetup = () => async (agentCtx: unknown): Promise<void> => {
    // Mirror the one-shot headless runner: couple a fixed model selection into
    // the agent scope so later DSH settings changes do not split this agent's
    // provider/model surfaces mid-conversation.
    installModelSelection(
      agentCtx as Parameters<typeof installModelSelection>[0],
      selection as Parameters<typeof installModelSelection>[1],
    );
  };

  let resumed = false;
  let handle: DshAgentHandleLike | undefined;
  try {
    const snapshot = await host.sessionPersistence.stat(SessionId(dshId));
    if (snapshot !== undefined) {
      log(`resuming DSH session ${dshId} for OpenClaw session ${openclawSessionId}`);
      handle = await host.agents.resume({
        resumeSessionId: SessionId(dshId),
        agentOptions,
        setup: makeSetup(),
      });
      resumed = true;
    }
  } catch (error) {
    // stat()/resume() throwing for a session that does not exist is the
    // normal first-run path; anything else is reported by create() below.
    log(`DSH session ${dshId} not resumable (${String(error)}); creating fresh`);
  }

  if (handle === undefined) {
    log(`creating DSH session ${dshId} for OpenClaw session ${openclawSessionId} (cwd=${cwd})`);
    try {
      handle = await host.agents.create({
        sessionId: SessionId(dshId),
        meta: { cwd },
        agentOptions,
        setup: makeSetup(),
      });
    } catch (createError) {
      // A stored log with this id can collide with a fresh create when the
      // pre-check missed it (e.g. stat raced a previous gateway process).
      // Fall back to resume once; anything else propagates to the attempt.
      const message = String(createError);
      if (/persisted log|already owns|already exists|collision/i.test(message)) {
        log(`DSH create collided with persisted log for ${dshId}; resuming`);
        handle = await host.agents.resume({
          resumeSessionId: SessionId(dshId),
          agentOptions,
          setup: makeSetup(),
        });
        resumed = true;
      } else {
        throw createError;
      }
    }
  }

  const entry: AgentEntry = {
    dshId,
    cwd,
    handle,
    selection,
    turn: Promise.resolve(),
  };
  agentEntries.set(dshId, entry);
  if (resumed) log(`DSH session ${dshId} resumed`);
  return entry;
}

/** Dispose one session's DSH agent (OpenClaw /new semantics). */
export async function disposeAgent(openclawSessionId: string): Promise<void> {
  const dshId = toDshSessionId(openclawSessionId);
  const entry = agentEntries.get(dshId);
  if (entry === undefined) return;
  agentEntries.delete(dshId);
  try {
    entry.handle.agent.cancel({ kind: "disposed" });
  } catch (error) {
    log(`failed to cancel DSH agent ${dshId}: ${String(error)}`);
  }
  try {
    await withDisposeTimeout(entry.handle.dispose(), AGENT_DISPOSE_TIMEOUT_MS, `dispose ${dshId}`);
    log(`disposed DSH agent ${dshId}`);
  } catch (error) {
    log(`failed to dispose DSH agent ${dshId}: ${String(error)}`);
  }
}

/**
 * Point one live DSH agent at the route OpenClaw prepared for the next attempt.
 * DSH applies the change when the next step enters prompt assembly, so an
 * in-flight turn never observes a split provider/model pair.
 */
export function selectAgentModel(
  entry: AgentEntry,
  selection: DshModelSelection | undefined,
): void {
  entry.selection.current = selection === undefined ? undefined : { ...selection };
}

/** Serialize one turn against an agent entry; runs `body` when its turn comes. */
export function enqueueTurn<T>(entry: AgentEntry, body: () => Promise<T>): Promise<T> {
  const run = entry.turn.then(body, body);
  entry.turn = run.catch(() => undefined);
  return run;
}

/** Dispose every DSH agent plus the shared host (plugin unload). */
export async function disposeHost(): Promise<void> {
  disposed = true;
  // The next generation boots a fresh host with a fresh launch-environment
  // snapshot, so its model mirror must be rebuilt from that generation's
  // OpenClaw config/credentials rather than reusing the retired one.
  resetModelMirror();
  const entries = [...agentEntries.values()];
  agentEntries.clear();

  // Cancel live turns first: an agent waiting on a model call would otherwise
  // keep handle.dispose() (and OpenClaw's drain) waiting for the full turn.
  for (const entry of entries) {
    try {
      entry.handle.agent.cancel({ kind: "disposed" });
    } catch (error) {
      log(`failed to cancel DSH agent ${entry.dshId}: ${String(error)}`);
    }
  }

  const pendingHost = hostPromise;
  hostPromise = undefined;

  await Promise.all(entries.map(async (entry) => {
    try {
      await withDisposeTimeout(entry.handle.dispose(), AGENT_DISPOSE_TIMEOUT_MS, `dispose ${entry.dshId}`);
    } catch (error) {
      log(`failed to dispose DSH agent ${entry.dshId}: ${String(error)}`);
    }
  }));

  if (pendingHost !== undefined) {
    const host = await pendingHost.catch(() => undefined);
    if (host !== undefined) {
      try {
        await withDisposeTimeout(host.dispose(), HOST_DISPOSE_TIMEOUT_MS, "host dispose");
      } catch (error) {
        log(`host dispose failed: ${String(error)}`);
      }
    }
  }

  // OpenClaw can reuse this module instance for the next plugin generation
  // (linked/dev plugins are not re-imported). Leaving the flag set would make
  // every later turn fail with "host was disposed"; a fresh generation is
  // allowed to boot a new host, while calls during this teardown still throw.
  disposed = false;
}

export { DEFAULT_TURN_TIMEOUT_MS };
