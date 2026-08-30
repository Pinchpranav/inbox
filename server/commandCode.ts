// commandCode.ts — vendored Command Code provider data + model fetch.
//
// Sourced from pi-commandcode-provider (MIT,
// https://github.com/patlux/pi-commandcode-provider, v0.5.1) and the
// command-code@1.36.0 bundled model catalog (verified against the npm
// package's dist/bundled/command-code-knowledge/reference/models.md).
// Zero runtime dependencies.
//
// Scope:
//   - static data tables: input modalities, reasoning efforts, thinking map
//   - fetchModels(): GET /provider/v1/models with a timeout, returns the list
//     in memory. NO file cache, NO fallback, NO cooldown — if the fetch
//     fails it throws and that's it. The caller (piSession wiring, gw6.4)
//     holds the result in memory and decides when to refetch.
//
// MIT License, Copyright (c) 2025 Pat Woz — vendored with attribution.

// ── Public model shape ─────────────────────────────────────────────

/** A model as exposed by the Command Code provider catalog. */
export interface CommandCodeModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

/**
 * A model as served to the UI by `GET /api/models` (build-gw6.5.1).
 * `thinkingLevelMap` comes from the per-model hardcoded table (the live API
 * does not expose it); `undefined` = this model does not reason. There is no
 * separate `reasoning` boolean — "does it reason?" == "has a thinkingLevelMap?".
 */
export interface ModelCatalogEntry {
  id: string;
  name: string;
  thinkingLevelMap: ThinkingMetadata["thinkingLevelMap"] | undefined;
  input: readonly CommandCodeInputType[];
}

// ── Input modalities ───────────────────────────────────────────────

export type CommandCodeInputType = "text" | "image";

/**
 * Model input modalities from the command-code@1.36.0 bundled catalog
 * (and the provider's synced commandcode-catalog.ts). Models omitted here
 * remain text-only so newly discovered IDs never claim image support without
 * upstream evidence.
 */
export const MODEL_INPUT_MODALITIES: Readonly<Record<string, readonly CommandCodeInputType[]>> = {
  "MiniMaxAI/MiniMax-M3": ["text", "image"],
  "Qwen/Qwen3.6-Plus": ["text", "image"],
  "Qwen/Qwen3.7-Flash": ["text", "image"],
  "Qwen/Qwen3.7-Plus": ["text", "image"],
  "claude-fable-5": ["text", "image"],
  "claude-haiku-4-5-20251001": ["text", "image"],
  "claude-opus-4-7": ["text", "image"],
  "claude-opus-4-8": ["text", "image"],
  "claude-opus-5": ["text", "image"],
  "claude-sonnet-4-6": ["text", "image"],
  "claude-sonnet-5": ["text", "image"],
  "deepseek/deepseek-v4-flash-vision-exp": ["text", "image"],
  "google/gemini-3.1-flash-lite": ["text", "image"],
  "google/gemini-3.5-flash": ["text", "image"],
  "google/gemini-3.5-flash-lite": ["text", "image"],
  "google/gemini-3.6-flash": ["text", "image"],
  "google/gemini-3.7-flash": ["text", "image"],
  "gpt-5.3-codex": ["text", "image"],
  "gpt-5.4": ["text", "image"],
  "gpt-5.4-mini": ["text", "image"],
  "gpt-5.5": ["text", "image"],
  "gpt-5.6-luna": ["text", "image"],
  "gpt-5.6-sol": ["text", "image"],
  "gpt-5.6-terra": ["text", "image"],
  "meta/muse-spark-1.1": ["text", "image"],
  "meta/muse-spark-1.2": ["text", "image"],
  "meta/muse-spark-1.2-contributor": ["text", "image"],
  "moonshotai/Kimi-K2.5": ["text", "image"],
  "moonshotai/Kimi-K2.6": ["text", "image"],
  "moonshotai/Kimi-K2.7-Code": ["text", "image"],
  "moonshotai/Kimi-K2.7-Code-Highspeed": ["text", "image"],
  "moonshotai/Kimi-K3": ["text", "image"],
  "Qwen/Qwen3.8-27B": ["text", "image"],
  "Qwen/Qwen3.8-Flash": ["text", "image"],
  "Qwen/Qwen3.8-Max": ["text", "image"],
  "sakana/fugu-ultra": ["text", "image"],
  "stepfun/Step-3.7-Flash": ["text", "image"],
  "thinkingmachines/inkling": ["text", "image"],
  "thinkingmachines/inkling-small": ["text", "image"],
  "xai/grok-4.5": ["text", "image"],
  "xiaomi/mimo-v2.5": ["text", "image"],
  "z-ai/glm-5.3-flash": ["text", "image"],
};

const TEXT_INPUT_ONLY: readonly CommandCodeInputType[] = ["text"];

/** Modalities a model accepts. Unknown/new models default to text-only. */
export function inputModalitiesForModel(modelId: string): readonly CommandCodeInputType[] {
  return MODEL_INPUT_MODALITIES[modelId] ?? TEXT_INPUT_ONLY;
}

/** Whether a model can accept image input. */
export function modelSupportsImageInput(modelId: string): boolean {
  return inputModalitiesForModel(modelId).includes("image");
}

/**
 * Models that reason at all (with or without selectable efforts).
 *
 * The Provider API does not expose this. Snapshot of `MODEL_REASONING` from
 * the provider's synced commandcode-catalog.ts (command-code@1.32.2), which
 * lists reasoning models even when Command Code chooses their depth
 * automatically (no `MODEL_EFFORTS` entry). A model in this set but not in
 * MODEL_EFFORTS reasons with automatic depth.
 */
export const MODEL_REASONING: Readonly<Record<string, true>> = {
  "claude-fable-5": true,
  "claude-opus-4-7": true,
  "claude-opus-4-8": true,
  "claude-opus-5": true,
  "claude-sonnet-4-6": true,
  "claude-sonnet-5": true,
  "deepseek/deepseek-v4-flash": true,
  "deepseek/deepseek-v4-flash-vision-exp": true,
  "deepseek/deepseek-v4-pro": true,
  "google/gemini-3.1-flash-lite": true,
  "google/gemini-3.5-flash": true,
  "google/gemini-3.5-flash-lite": true,
  "google/gemini-3.6-flash": true,
  "google/gemini-3.7-flash": true,
  "gpt-5.3-codex": true,
  "gpt-5.4": true,
  "gpt-5.4-mini": true,
  "gpt-5.5": true,
  "gpt-5.6-luna": true,
  "gpt-5.6-sol": true,
  "gpt-5.6-terra": true,
  "meta/muse-spark-1.1": true,
  "meta/muse-spark-1.2": true,
  "meta/muse-spark-1.2-contributor": true,
  "MiniMaxAI/MiniMax-M3": true,
  "moonshotai/Kimi-K2.7-Code": true,
  "moonshotai/Kimi-K2.7-Code-Highspeed": true,
  "moonshotai/Kimi-K3": true,
  "nvidia/nemotron-3-ultra-550b-a55b": true,
  "poolside/laguna-s-2.1-free": true,
  "Qwen/Qwen3.6-Max-Preview": true,
  "Qwen/Qwen3.6-Plus": true,
  "Qwen/Qwen3.7-Flash": true,
  "Qwen/Qwen3.7-Max": true,
  "Qwen/Qwen3.7-Plus": true,
  "Qwen/Qwen3.8-27B": true,
  "Qwen/Qwen3.8-Flash": true,
  "Qwen/Qwen3.8-Max": true,
  "sakana/fugu-ultra": true,
  "stealth/ox-alpha": true,
  "stepfun/Step-3.5-Flash": true,
  "stepfun/Step-3.7-Flash": true,
  "tencent/hy3-paid": true,
  "thinkingmachines/inkling": true,
  "thinkingmachines/inkling-small": true,
  "xai/grok-4.5": true,
  "xai/grok-4.6": true,
  "zai-org/GLM-5.2": true,
  "zai-org/GLM-5.3": true,
  "z-ai/glm-5.3-flash": true,
};

/** Whether a model id is a known reasoning model (has a MODEL_REASONING entry). */
function isReasoningModel(modelId: string): boolean {
  return MODEL_REASONING[modelId] !== undefined;
}

// ── Thinking levels (pi's ModelThinkingLevel) ──────────────────────

/** pi's canonical thinking-level ladder. */
export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

type CommandCodeReasoningEffort = Exclude<PiThinkingLevel, "off">;

/**
 * Per-model reasoning efforts supported by Command Code's generate endpoint.
 *
 * The Provider API does not expose reasoning metadata. This is an exact
 * snapshot of `reasoningEfforts` from the command-code@1.36.0 model catalog
 * (published in the generated
 * `dist/bundled/command-code-knowledge/reference/models.md`). Models omitted
 * here let Command Code choose their reasoning depth, matching the CLI.
 *
 * NOTE: an omitted entry means "no selectable effort", NOT "does not reason"
 * — many `—` models (Kimi, MiniMax, muse-spark, Qwen3.7/3.6, claude-haiku,
 * stepfun, nemotron, poolside, tencent/hy3) still reason with Command Code
 * deciding depth automatically. See `MODEL_REASONING` for the authoritative
 * "does it reason?" set.
 */
export const MODEL_EFFORTS: Readonly<Record<string, readonly CommandCodeReasoningEffort[]>> = {
  "Qwen/Qwen3.8-Max": ["low", "medium", "xhigh"],
  "claude-fable-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-7": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-4-6": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
  "deepseek/deepseek-v4-flash": ["high", "max"],
  "deepseek/deepseek-v4-flash-vision-exp": ["high", "max"],
  "deepseek/deepseek-v4-pro": ["high", "max"],
  "gpt-5.3-codex": ["low", "medium", "high", "xhigh"],
  "gpt-5.4": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["low", "medium", "high"],
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max"],
  "google/gemini-3.1-flash-lite": ["low", "medium", "high"],
  "google/gemini-3.5-flash": ["low", "medium", "high"],
  "google/gemini-3.5-flash-lite": ["low", "medium", "high"],
  "google/gemini-3.6-flash": ["low", "medium", "high"],
  "google/gemini-3.7-flash": ["low", "medium", "high"],
  "Qwen/Qwen3.8-27B": ["low", "medium", "xhigh"],
  "Qwen/Qwen3.8-Flash": ["low", "medium", "xhigh"],
  "sakana/fugu-ultra": ["high", "xhigh"],
  "xai/grok-4.5": ["low", "medium", "high"],
  "xai/grok-4.6": ["low", "medium", "high", "xhigh"],
  "z-ai/glm-5.3-flash": ["low", "high", "max"],
  "zai-org/GLM-5.2": ["high", "max"],
  "zai-org/GLM-5.3": ["low", "high", "max"],
};

export const PI_THINKING_LEVELS: readonly PiThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * Map pi's thinking-level ladder onto the reasoning efforts a model supports.
 * `"off"` is never in the map (it is the absence of thinking); unsupported
 * levels map to null so the UI can render them disabled.
 */
export function thinkingLevelMapForEfforts(
  efforts: readonly string[],
): Partial<Record<PiThinkingLevel, string | null>> {
  const map: Partial<Record<PiThinkingLevel, string | null>> = {};
  for (const level of PI_THINKING_LEVELS) {
    if (level === "off") continue;
    map[level] = efforts.includes(level) ? level : null;
  }
  return map;
}

/** Full thinking metadata pi attaches to a model (thinkingLevelMap + effort map). */
export interface ThinkingMetadata {
  thinkingLevelMap: Partial<Record<PiThinkingLevel, string | null>>;
  thinking: {
    mode: "effort";
    effortMap: Partial<Record<CommandCodeReasoningEffort, string>>;
    efforts: readonly CommandCodeReasoningEffort[];
  };
}

/** Thinking metadata for a model, or undefined when it isn't a reasoning model. */
export function thinkingMetadataForModel(modelId: string): ThinkingMetadata | undefined {
  const efforts = MODEL_EFFORTS[modelId];
  if (!efforts) return undefined;
  return {
    thinkingLevelMap: thinkingLevelMapForEfforts(efforts),
    thinking: {
      mode: "effort",
      effortMap: Object.fromEntries(efforts.map((effort) => [effort, effort])),
      efforts,
    },
  };
}

// ── Model catalog: fetch (build-gw6.2, simplified) ─────────────────

/** Default Command Code provider models endpoint. */
export const DEFAULT_MODELS_URL = "https://api.commandcode.ai/provider/v1/models";

/** Default timeout for a models fetch (ms). */
export const DEFAULT_MODELS_TIMEOUT_MS = 10_000;

/** Cap on maxTokens we advertise per model (the API returns only contextLength). */
const DEFAULT_MAX_OUTPUT_TOKENS = 65_536;

export interface FetchModelsOptions {
  /** Models endpoint. Defaults to DEFAULT_MODELS_URL. */
  url?: string;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Abort an in-flight fetch (e.g. shutdown). */
  signal?: AbortSignal;
  /** Timeout in ms. Defaults to DEFAULT_MODELS_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * GET /provider/v1/models → CommandCodeModel[].
 *
 * Throws on: HTTP error, malformed body, timeout, or abort. No file cache,
 * no fallback — the caller holds the result in memory and refetches when it
 * wants (gw6.4 wiring). `reasoning` comes from our static MODEL_EFFORTS table
 * (the API does not expose it); `maxTokens` is capped at 64K because the API
 * only reports context length.
 */
export async function fetchModels(options: FetchModelsOptions = {}): Promise<CommandCodeModel[]> {
  const url = options.url ?? DEFAULT_MODELS_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS;
  const signal = options.signal ?? AbortSignal.timeout(timeoutMs);

  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch Command Code models: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as unknown;
  if (typeof body !== "object" || body === null || !Array.isArray((body as { data?: unknown }).data)) {
    throw new Error("Expected Command Code models response to be { object: 'list', data: [...] }");
  }

  const models = ((body as { data: unknown[] }).data).map((entry) => {
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    const name = typeof record.name === "string" ? record.name : id;
    const contextLength = typeof record.context_length === "number" ? record.context_length : 0;
    if (!id || contextLength <= 0) {
      throw new Error(`Expected model entry to have a non-empty id and positive context_length`);
    }
    return {
      id,
      name,
      reasoning: isReasoningModel(id),
      contextWindow: contextLength,
      maxTokens: Math.min(contextLength, DEFAULT_MAX_OUTPUT_TOKENS),
    };
  });

  if (models.length === 0) throw new Error("Command Code returned an empty model catalog");
  return models;
}

// ── Single namespace export ────────────────────────────────────────

/** Flat namespace so index.ts / tests can import one object. */
export const COMMAND_CODE = {
  MODEL_INPUT_MODALITIES,
  MODEL_EFFORTS,
  MODEL_REASONING,
  PI_THINKING_LEVELS,
  DEFAULT_MODELS_URL,
  DEFAULT_MODELS_TIMEOUT_MS,
  fetchModels,
} as const;
