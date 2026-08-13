/**
 * Embedded DeepSeek Harness (DSH) host: boots one DSH core tree inside the
 * OpenClaw gateway process and hands out per-OpenClaw-session DSH Agents.
 *
 * Boot mechanics (verified against @deepseek-ai/dsh-app-boot 0.1.0-rc.6):
 * - The plugin ships a DSH profile template under ../config (package.json
 *   declaring dsh.profile.bundles plus an empty cordis.yml and a static
 *   cordis.patch.yml overlay).
 * - boot(binName, absoluteConfigPath, patches, prepare, bareModuleBaseUrl)
 *   mounts that cordis.yml with an explicit patch list; bundle patches are
 *   loaded with loadOverlayPatches, the static overlay with
 *   loadOptionalPatches, and operator-config rows are appended last so they
 *   always win.
 * - bareModuleBaseUrl points at the plugin's own node_modules so bare package
 *   rows (@deepseek-ai/dsh-*) resolve from the plugin dependency tree.
 * - $DSH_HOME is resolved at module import time, so it must be pinned on
 *   process.env before the first dynamic import of dsh-app-boot.
 */
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import type {
  DshAgentHandleLike,
  DshHost,
  DshPluginConfig,
} from "./types.js";

const BIN_NAME = "openclaw-plugin-dsh";

/** The persona used when the operator does not override it. */
export const DEFAULT_PERSONA =
  "You are the DeepSeek Harness agent embedded inside OpenClaw. Your working directory is {{cwd}}.";

const DEFAULT_TURN_TIMEOUT_MS = 900_000;

let hostPromise: Promise<DshHost> | undefined;
let disposed = false;

/** Per-OpenClaw-session DSH agent bookkeeping. */
interface AgentEntry {
  dshId: string;
  cwd: string;
  handle: DshAgentHandleLike;
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

async function bootOnce(config: DshPluginConfig): Promise<DshHost> {
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

  // Layer 2: this plugin's static overlay (empty when the file is absent).
  const staticPatches = bootMod.loadOptionalPatches(BIN_NAME, join(profileDir, "cordis.patch.yml")) as Record<string, unknown>[];
  layers.push(...staticPatches);

  // Layer 3: operator-config rows, applied last so they always win.
  layers.push(
    {
      id: "system-prompt",
      config: { persona: config.persona ?? DEFAULT_PERSONA },
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

  log(
    `booting embedded DSH host: profile=${profileDir} dshHome=${process.env.DSH_HOME ?? "<default>"} ` +
      `bundles=${bundles.join(",")}`,
  );
  const ctx = (await bootMod.boot(
    BIN_NAME,
    cordisYml,
    layers,
    undefined,
    bareModuleBaseUrl,
  )) as unknown as BootedServices["ctx"];

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
export async function ensureHost(config: DshPluginConfig): Promise<DshHost> {
  if (disposed) throw new Error(`${BIN_NAME}: host was disposed`);
  hostPromise ??= bootOnce(config).catch((error: unknown) => {
    hostPromise = undefined;
    throw error;
  });
  return hostPromise;
}

/** Resolve the DSH agent options for one OpenClaw session. */
export function resolveAgentOptions(
  host: DshHost,
  config: DshPluginConfig,
): { provider: string; model: string } | undefined {
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
  agentOptions: { provider: string; model: string } | undefined,
): Promise<AgentEntry> {
  const dshId = toDshSessionId(openclawSessionId);
  const existing = agentEntries.get(dshId);
  if (existing !== undefined) return existing;

  const setup = (agentCtx: unknown): void => {
    // Mirror the one-shot headless runner: couple a fixed model selection into
    // the agent scope so later DSH settings changes do not split this agent's
    // provider/model surfaces mid-conversation.
    installModelSelection(
      agentCtx as Parameters<typeof installModelSelection>[0],
      agentOptions === undefined
        ? { current: undefined, assembled: undefined }
        : { current: { ...agentOptions }, assembled: undefined },
    );
  };

  let resumed = false;
  let handle: DshAgentHandleLike | undefined;
  try {
    const inspection = await host.sessionPersistence.inspect(SessionId(dshId));
    if (inspection !== undefined) {
      log(`resuming DSH session ${dshId} for OpenClaw session ${openclawSessionId}`);
      handle = await host.agents.resume({
        resumeSessionId: SessionId(dshId),
        agentOptions,
        setup,
      });
      resumed = true;
    }
  } catch (error) {
    // inspect()/resume() throwing for a session that does not exist is the
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
        setup,
      });
    } catch (createError) {
      // A stored log with this id can collide with a fresh create when the
      // pre-check missed it (e.g. inspect raced a previous gateway process).
      // Fall back to resume once; anything else propagates to the attempt.
      const message = String(createError);
      if (/persisted log|already exists|collision/i.test(message)) {
        log(`DSH create collided with persisted log for ${dshId}; resuming`);
        handle = await host.agents.resume({
          resumeSessionId: SessionId(dshId),
          agentOptions,
          setup,
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
    await entry.handle.dispose();
    log(`disposed DSH agent ${dshId}`);
  } catch (error) {
    log(`failed to dispose DSH agent ${dshId}: ${String(error)}`);
  }
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
  for (const dshId of [...agentEntries.keys()]) {
    const entry = agentEntries.get(dshId);
    agentEntries.delete(dshId);
    if (entry === undefined) continue;
    try {
      await entry.handle.dispose();
    } catch (error) {
      log(`failed to dispose DSH agent ${dshId}: ${String(error)}`);
    }
  }
  if (hostPromise !== undefined) {
    const host = await hostPromise.catch(() => undefined);
    if (host !== undefined) await host.dispose().catch((error) => log(`host dispose failed: ${String(error)}`));
    hostPromise = undefined;
  }
}

export { DEFAULT_TURN_TIMEOUT_MS };
