/**
 * Mirror OpenClaw's prepared model route into the embedded DeepSeek Harness.
 *
 * OpenClaw already resolves everything a model call needs before it dispatches
 * an agent-harness attempt: `params.provider`, `params.modelId`, the prepared
 * `params.model` (api, baseUrl, context window, max tokens, input modalities),
 * `params.resolvedApiKey`, and an `authStorage` facade over the canonical auth
 * profile store. A harness pinned via `agentRuntime.id: "dsh"` must reproduce
 * that exact route instead of letting DSH pick its own default provider.
 *
 * DSH's `llm-pi-ai` row accepts a `providers` dict at boot. We translate every
 * OpenClaw `models.providers.<id>` entry into one route of that dict, and turn
 * each OpenClaw auth profile key into a credential reference the DSH
 * credentials service can resolve.
 *
 * Credential handling: DSH's credentials provider reads the *launch-time*
 * environment snapshot, which `dsh-app-boot` freezes from `process.env` during
 * `boot()`. We therefore publish the resolved keys as short-lived process
 * environment variables, boot the host, then restore the previous values.
 * The frozen snapshot keeps the key resolvable for `llm-pi-ai`, while DSH
 * tools that spawn child processes never inherit it.
 */
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";

const BIN_NAME = "openclaw-plugin-dsh";

/** Wire protocols `llm-pi-ai` can build for a hand-declared route. */
const SUPPORTED_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
]);

/** The route id OpenClaw uses for DSH's own synthetic provider. */
const DSH_PROVIDER_ID = "dsh";

interface OpenClawProviderModelLike {
  id?: unknown;
  name?: unknown;
  api?: unknown;
  contextWindow?: unknown;
  maxTokens?: unknown;
  input?: unknown;
  reasoning?: unknown;
}

interface OpenClawProviderLike {
  baseUrl?: unknown;
  api?: unknown;
  headers?: unknown;
  models?: unknown;
}

interface OpenClawModelsConfigLike {
  providers?: Record<string, OpenClawProviderLike>;
}

interface OpenClawConfigLike {
  models?: OpenClawModelsConfigLike;
}

/** One model entry in a DSH `llm-pi-ai` provider profile. */
export interface DshModelProfileLike {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: Array<"text" | "image">;
}

/** One provider route in a DSH `llm-pi-ai` provider profile. */
export interface DshProviderProfileLike {
  api?: string;
  baseURL?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  models: DshModelProfileLike[];
}

/** Everything the boot layer needs to reproduce OpenClaw's model routes. */
export interface OpenClawModelMirror {
  /** `llm-pi-ai` provider profiles keyed by the OpenClaw provider id. */
  profiles: Record<string, DshProviderProfileLike>;
  /**
   * Credential-reference values to publish in `process.env` only for the
   * duration of the DSH boot (the launch snapshot keeps them resolvable).
   */
  environment: Record<string, string>;
  /** Model selection for the current attempt; absent for `dsh/<model>` refs. */
  selection?: { provider: string; model: string };
}

let mirrorPromise: Promise<OpenClawModelMirror | undefined> | undefined;

/** Rebuild the mirror on the next call (host disposal / plugin reload). */
export function resetModelMirror(): void {
  mirrorPromise = undefined;
}

/**
 * Resolve the model selection one attempt must install, verifying that the
 * booted host actually registered the provider's route and model. A provider
 * added to the OpenClaw config after the DSH host booted is not servable
 * until the next gateway/plugin restart.
 */
export function attemptSelectionFor(
  mirror: OpenClawModelMirror,
  provider: string,
  modelId: string,
): { provider: string; model: string } {
  if (provider === DSH_PROVIDER_ID) {
    throw new Error(`${BIN_NAME}: attemptSelectionFor must not be called for the dsh provider`);
  }
  const profile = mirror.profiles[provider];
  if (profile === undefined) {
    throw new Error(
      `${BIN_NAME}: OpenClaw provider "${provider}" was not mirrored when the embedded DSH host booted; ` +
        `restart the gateway after adding a provider to openclaw.json`,
    );
  }
  if (!profile.models.some((model) => model.id === modelId)) {
    throw new Error(
      `${BIN_NAME}: model "${modelId}" is not declared for OpenClaw provider "${provider}"; ` +
        `the embedded DSH host can only serve models present when it booted`,
    );
  }
  return { provider, model: modelId };
}

/**
 * Build (once per boot generation) the model mirror for an attempt. The host is
 * booted once, so the first attempt that reaches it must contribute every route
 * the OpenClaw config declares; later attempts reuse the booted routes.
 */
export function loadModelMirror(
  params: AgentHarnessAttemptParamsV2,
): Promise<OpenClawModelMirror | undefined> {
  mirrorPromise ??= buildOpenClawModelMirror(params).catch((error: unknown) => {
    mirrorPromise = undefined;
    throw error;
  });
  return mirrorPromise;
}

/** Translate OpenClaw model metadata into a DSH model profile. */
function toModelProfile(
  id: string,
  model: Partial<OpenClawProviderModelLike> & { input?: unknown },
): DshModelProfileLike {
  const profile: DshModelProfileLike = { id };
  if (typeof model.name === "string" && model.name !== "") profile.name = model.name;
  if (typeof model.contextWindow === "number" && Number.isInteger(model.contextWindow) && model.contextWindow > 0) {
    profile.contextWindow = model.contextWindow;
  }
  if (typeof model.maxTokens === "number" && Number.isInteger(model.maxTokens) && model.maxTokens > 0) {
    profile.maxTokens = model.maxTokens;
  }
  if (Array.isArray(model.input)) {
    const input = model.input.filter(
      (value): value is "text" | "image" => value === "text" || value === "image",
    );
    if (input.length > 0) profile.input = input;
  }
  return profile;
}

/** Map a configured provider's model list, skipping entries without an id. */
function toModelProfiles(models: unknown): DshModelProfileLike[] {
  if (!Array.isArray(models)) return [];
  const profiles: DshModelProfileLike[] = [];
  for (const raw of models) {
    if (raw === null || typeof raw !== "object") continue;
    const entry = raw as OpenClawProviderModelLike;
    if (typeof entry.id !== "string" || entry.id === "") continue;
    profiles.push(toModelProfile(entry.id, entry));
  }
  return profiles;
}

/** Copy a string-valued header map; anything else is ignored. */
function toHeaders(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue === "string") headers[name] = headerValue;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * Resolve the API key OpenClaw would use for one provider. The current
 * attempt's prepared key wins; other providers go through the auth-profile
 * facade. `getAuthStatus` avoids triggering OAuth refreshes for providers the
 * user never authenticated.
 */
async function resolveProviderKey(
  params: AgentHarnessAttemptParamsV2,
  providerId: string,
  baseUrl: string | undefined,
  isCurrent: boolean,
): Promise<string | undefined> {
  if (isCurrent && typeof params.resolvedApiKey === "string" && params.resolvedApiKey !== "") {
    return params.resolvedApiKey;
  }
  const authStorage = params.authStorage as
    | {
        getAuthStatus?(provider: string): { configured?: boolean } | undefined;
        getApiKey?(provider: string, options?: { includeFallback?: boolean; baseUrl?: string }): Promise<string | undefined>;
      }
    | undefined;
  if (authStorage?.getApiKey === undefined) return undefined;
  try {
    const status = authStorage.getAuthStatus?.(providerId);
    if (status !== undefined && status.configured === false) return undefined;
    const key = await authStorage.getApiKey(
      providerId,
      baseUrl === undefined ? undefined : { baseUrl },
    );
    return typeof key === "string" && key !== "" ? key : undefined;
  } catch {
    // A provider without usable credentials stays registered; its first request
    // reports MISSING_CREDENTIAL through the DSH llm-pi-ai seam.
    return undefined;
  }
}

/**
 * Build the DSH provider profiles for one OpenClaw attempt.
 *
 * @throws when the attempt's own provider cannot be expressed as a DSH route;
 *   the harness reports that as the attempt's promptError.
 */
async function buildOpenClawModelMirror(
  params: AgentHarnessAttemptParamsV2,
): Promise<OpenClawModelMirror | undefined> {
  const config = params.config as unknown as OpenClawConfigLike | undefined;
  const configuredProviders = config?.models?.providers ?? {};
  const currentProvider = typeof params.provider === "string" ? params.provider : "";
  const currentModelId =
    typeof params.modelId === "string" && params.modelId !== ""
      ? params.modelId
      : typeof params.model?.id === "string"
        ? params.model.id
        : "";
  const currentModel = params.model as
    | (Partial<OpenClawProviderModelLike> & { api?: string; baseUrl?: string })
    | undefined;

  const profiles: Record<string, DshProviderProfileLike> = {};
  const environment: Record<string, string> = {};
  let routeIndex = 0;

  const addRoute = async (
    providerId: string,
    provider: OpenClawProviderLike | undefined,
    attemptModel: typeof currentModel,
    attemptModelId: string | undefined,
  ): Promise<void> => {
    if (providerId === DSH_PROVIDER_ID) return;
    const api = typeof provider?.api === "string"
      ? provider.api
      : attemptModel?.api;
    if (typeof api !== "string" || !SUPPORTED_APIS.has(api)) return;
    const baseURL = typeof provider?.baseUrl === "string" && provider.baseUrl !== ""
      ? provider.baseUrl
      : typeof attemptModel?.baseUrl === "string" && attemptModel.baseUrl !== ""
        ? attemptModel.baseUrl
        : undefined;
    if (baseURL === undefined) return;

    const models = toModelProfiles(provider?.models);
    if (
      attemptModel !== undefined &&
      attemptModelId !== undefined &&
      !models.some((model) => model.id === attemptModelId)
    ) {
      // The prepared model can carry a runtime id the static config omits
      // (aliases, per-agent overrides). Register it so pi-ai can serve it.
      models.push(toModelProfile(attemptModelId, attemptModel));
    }
    if (models.length === 0) return;

    const envName = `OPENCLAW_DSH_API_KEY_${routeIndex++}`;
    const isCurrent = providerId === currentProvider;
    const key = await resolveProviderKey(params, providerId, baseURL, isCurrent);
    if (key !== undefined) environment[envName] = key;
    const headers = toHeaders(provider?.headers);

    profiles[providerId] = {
      api,
      baseURL,
      // Keeping the reference even when the key is absent gives the turn a
      // precise MISSING_CREDENTIAL instead of pi-ai's ambient-discovery error.
      apiKeyEnv: envName,
      ...(headers === undefined ? {} : { headers }),
      models,
    };
  };

  for (const [providerId, provider] of Object.entries(configuredProviders)) {
    const isCurrent = providerId === currentProvider;
    await addRoute(
      providerId,
      provider,
      isCurrent ? currentModel : undefined,
      isCurrent ? currentModelId : undefined,
    );
  }

  // The attempt's provider need not appear in `models.providers` (a provider
  // plugin or a built-in route can still serve it); the prepared model is
  // enough to declare a self-contained pi-ai route.
  if (currentProvider !== DSH_PROVIDER_ID && profiles[currentProvider] === undefined) {
    await addRoute(
      currentProvider,
      {
        api: currentModel?.api,
        baseUrl: currentModel?.baseUrl,
        models: [],
      },
      currentModel,
      currentModelId,
    );
  }

  if (Object.keys(profiles).length === 0) return undefined;

  if (currentProvider !== DSH_PROVIDER_ID) {
    if (profiles[currentProvider] === undefined) {
      const api = typeof currentModel?.api === "string" ? currentModel.api : "unknown";
      const baseUrl = typeof currentModel?.baseUrl === "string" ? currentModel.baseUrl : "unknown";
      throw new Error(
        `${BIN_NAME}: cannot route OpenClaw provider "${currentProvider}" ` +
          `(api "${api}", baseUrl "${baseUrl}") through the embedded DSH runtime; ` +
          `supported APIs are ${[...SUPPORTED_APIS].join(", ")}. ` +
          `Pin this agent to agentRuntime "openclaw", or configure the provider with a supported API.`,
      );
    }
    if (currentModelId === "") {
      throw new Error(`${BIN_NAME}: OpenClaw attempt for provider "${currentProvider}" has no model id`);
    }
  }

  return {
    profiles,
    environment,
    ...(currentProvider === DSH_PROVIDER_ID || currentModelId === ""
      ? {}
      : { selection: { provider: currentProvider, model: currentModelId } }),
  };
}
