// commandCode.ts — vendored Command Code provider data + catalog (constants, fetch, cache).
//
// SCOPE: the data/static parts of pi-commandcode-provider
// (MIT, https://github.com/patlux/pi-commandcode-provider, v0.5.1): model
// input modalities, reasoning efforts, thinking-level map, pricing tables
// (gw6.1), plus the catalog FETCH + file cache (gw6.2: live refresh, atomic
// cache file, coalesced refresh, cooldown). NO streaming, NO auth, NO
// extension — those land in the piSession wiring step (gw6.4).
//
// Source of truth: command-code@1.15.1 bundled catalog + Command Code docs
// pricing (https://commandcode.ai/docs/resources/pricing-limits), as snapshotted
// by pi-commandcode-provider. These tables only change when that package bumps.
//
// The data tables are exported twice so consumers can pick their style:
//   - named exports (inputModalitiesForModel, MODEL_COSTS, ...)
//   - a single `COMMAND_CODE` namespace object (index.ts / tests import one flat)
//
// MIT License, Copyright (c) 2025 Pat Woz — vendored with attribution.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// ── Public model shape ─────────────────────────────────────────────

/** A model as exposed by the Command Code provider catalog. */
export interface CommandCodeModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

// ── Input modalities ───────────────────────────────────────────────

export type CommandCodeInputType = "text" | "image";

/**
 * Model input modalities from the command-code@1.15.1 bundled catalog.
 * Models omitted here remain text-only so newly discovered IDs never claim
 * image support without upstream evidence.
 */
export const MODEL_INPUT_MODALITIES: Readonly<Record<string, readonly CommandCodeInputType[]>> = {
  "MiniMaxAI/MiniMax-M3": ["text", "image"],
  "Qwen/Qwen3.6-Plus": ["text", "image"],
  "Qwen/Qwen3.7-Flash": ["text", "image"],
  "Qwen/Qwen3.7-Plus": ["text", "image"],
  "Qwen/Qwen3.8-Max": ["text", "image"],
  "claude-fable-5": ["text", "image"],
  "claude-haiku-4-5-20251001": ["text", "image"],
  "claude-opus-4-7": ["text", "image"],
  "claude-opus-4-8": ["text", "image"],
  "claude-opus-5": ["text", "image"],
  "claude-sonnet-4-6": ["text", "image"],
  "claude-sonnet-5": ["text", "image"],
  "google/gemini-3.1-flash-lite": ["text", "image"],
  "google/gemini-3.5-flash": ["text", "image"],
  "google/gemini-3.5-flash-lite": ["text", "image"],
  "google/gemini-3.6-flash": ["text", "image"],
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
  "sakana/fugu-ultra": ["text", "image"],
  "stepfun/Step-3.7-Flash": ["text", "image"],
  "thinkingmachines/inkling": ["text", "image"],
  "thinkingmachines/inkling-small": ["text", "image"],
  "xai/grok-4.5": ["text", "image"],
  "xiaomi/mimo-v2.5": ["text", "image"],
};

const TEXT_INPUT_ONLY: readonly CommandCodeInputType[] = ["text"];

/**
 * Whether a model id is a known reasoning model (has a MODEL_EFFORTS entry).
 * Internal — used to derive `reasoning` when parsing API/cache entries.
 */
function isReasoningModel(modelId: string): boolean {
  return MODEL_EFFORTS[modelId] !== undefined;
}

/** Modalities a model accepts. Unknown/new models default to text-only. */
export function inputModalitiesForModel(modelId: string): readonly CommandCodeInputType[] {
  return MODEL_INPUT_MODALITIES[modelId] ?? TEXT_INPUT_ONLY;
}

/** Whether a model can accept image input. */
export function modelSupportsImageInput(modelId: string): boolean {
  return inputModalitiesForModel(modelId).includes("image");
}

// ── Thinking levels (pi's ModelThinkingLevel) ──────────────────────

/** pi's canonical thinking-level ladder. */
export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

type CommandCodeReasoningEffort = Exclude<PiThinkingLevel, "off">;

/**
 * Per-model reasoning efforts supported by Command Code's generate endpoint.
 *
 * The Provider API does not expose reasoning metadata. This is an exact
 * snapshot of `reasoningEfforts` from the command-code@1.15.1 model catalog
 * (`packages/shared/src/model-catalog.ts`, also published in the generated
 * `dist/bundled/command-code-knowledge/reference/models.md`). Models omitted
 * here let Command Code choose their reasoning depth, matching the CLI.
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
  "sakana/fugu-ultra": ["high", "xhigh"],
  "xai/grok-4.5": ["low", "medium", "high"],
  "zai-org/GLM-5.2": ["high", "max"],
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

// ── Pricing ────────────────────────────────────────────────────────

export interface CommandCodeModelCostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CommandCodeModelCostTier extends CommandCodeModelCostRates {
  inputTokensAbove: number;
}

export interface CommandCodeModelCost extends CommandCodeModelCostRates {
  tiers?: readonly CommandCodeModelCostTier[];
}

export interface TemporaryPricing {
  models: readonly string[];
  expiresOn: string;
  description: string;
}

export const PRICING_SOURCE_URL = "https://commandcode.ai/docs/resources/pricing-limits";
export const PRICING_LAST_VERIFIED = "2026-08-04";

export const ZERO_MODEL_COST: CommandCodeModelCost = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * Display prices in USD per million tokens.
 *
 * Context-dependent rates use pi's request-wide input pricing tiers. The
 * highest threshold exceeded by input + cache reads + cache writes applies to
 * the full request. The Command Code usage page remains authoritative for the
 * amount billed for an individual request.
 */
export const MODEL_COSTS: Readonly<Record<string, CommandCodeModelCost>> = {
  // Free models
  "poolside/laguna-s-2.1-free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "inclusionai/ling-3.0-flash-free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },

  // Open and open-weight models
  "tencent/hy3-paid": { input: 0.14, output: 0.58, cacheRead: 0.035, cacheWrite: 0 },
  "moonshotai/Kimi-K3": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
  "moonshotai/Kimi-K2.7-Code": { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
  "moonshotai/Kimi-K2.7-Code-Highspeed": {
    input: 1.9,
    output: 8,
    cacheRead: 0.38,
    cacheWrite: 0,
  },
  "moonshotai/Kimi-K2.6": { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
  "moonshotai/Kimi-K2.5": { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0 },
  "zai-org/GLM-5.2": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  "zai-org/GLM-5.2-Fast": { input: 3, output: 10.25, cacheRead: 0.5, cacheWrite: 0 },
  "zai-org/GLM-5.1": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  "zai-org/GLM-5": { input: 1, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
  "MiniMaxAI/MiniMax-M3": { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
  "MiniMaxAI/MiniMax-M2.7": { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
  "MiniMaxAI/MiniMax-M2.5": { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 },
  // Permanent 75% discount.
  "deepseek/deepseek-v4-pro": {
    input: 0.435,
    output: 0.87,
    cacheRead: 0.003625,
    cacheWrite: 0,
  },
  "deepseek/deepseek-v4-flash": {
    input: 0.14,
    output: 0.28,
    cacheRead: 0.0028,
    cacheWrite: 0,
  },
  "Qwen/Qwen3.8-Max": { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 2.5 },
  "Qwen/Qwen3.7-Max": { input: 2.5, output: 7.5, cacheRead: 0.5, cacheWrite: 3.13 },
  "Qwen/Qwen3.7-Plus": {
    input: 0.4,
    output: 1.6,
    cacheRead: 0.08,
    cacheWrite: 0.5,
    tiers: [
      {
        inputTokensAbove: 256_000,
        input: 1.2,
        output: 4.8,
        cacheRead: 0.24,
        cacheWrite: 1.5,
      },
    ],
  },
  "Qwen/Qwen3.7-Flash": {
    input: 0.03,
    output: 0.13,
    cacheRead: 0.006,
    cacheWrite: 0.038,
    tiers: [
      {
        inputTokensAbove: 32_000,
        input: 0.1,
        output: 0.4,
        cacheRead: 0.02,
        cacheWrite: 0.125,
      },
      {
        inputTokensAbove: 256_000,
        input: 0.2,
        output: 0.8,
        cacheRead: 0.04,
        cacheWrite: 0.25,
      },
    ],
  },
  "Qwen/Qwen3.6-Max-Preview": {
    input: 1.3,
    output: 7.8,
    cacheRead: 0.26,
    cacheWrite: 1.63,
  },
  "Qwen/Qwen3.6-Plus": { input: 0.5, output: 3, cacheRead: 0.1, cacheWrite: 0 },
  "stepfun/Step-3.7-Flash": { input: 0.2, output: 1.15, cacheRead: 0.04, cacheWrite: 0 },
  "stepfun/Step-3.5-Flash": { input: 0.1, output: 0.3, cacheRead: 0.02, cacheWrite: 0 },
  // Permanent discounted rates.
  "xiaomi/mimo-v2.5-pro": { input: 0.435, output: 0.87, cacheRead: 0.0036, cacheWrite: 0 },
  "xiaomi/mimo-v2.5": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
  "nvidia/nemotron-3-ultra-550b-a55b": {
    input: 0.6,
    output: 2.4,
    cacheRead: 0.12,
    cacheWrite: 0,
  },
  "sakana/fugu-ultra": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  "thinkingmachines/inkling": { input: 1, output: 4.05, cacheRead: 0.17, cacheWrite: 0 },
  "thinkingmachines/inkling-small": {
    input: 0.5,
    output: 1.2,
    cacheRead: 0.1,
    cacheWrite: 0,
  },
  "meta/muse-spark-1.1": { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },

  // Anthropic
  // Introductory pricing through 2026-08-31.
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-haiku-4-5-20251001": {
    input: 1,
    output: 5,
    cacheRead: 0.1,
    cacheWrite: 1.25,
  },

  // OpenAI
  "gpt-5.6-sol": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  // Discounted rates through 2026-08-14.
  "gpt-5.6-terra": {
    input: 1,
    output: 6,
    cacheRead: 0.1,
    cacheWrite: 1.25,
    tiers: [
      {
        inputTokensAbove: 272_000,
        input: 2,
        output: 9,
        cacheRead: 0.2,
        cacheWrite: 2.5,
      },
    ],
  },
  "gpt-5.6-luna": {
    input: 0.1,
    output: 0.6,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    tiers: [
      {
        inputTokensAbove: 272_000,
        input: 0.2,
        output: 0.9,
        cacheRead: 0.02,
        cacheWrite: 0.25,
      },
    ],
  },
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  "gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  "gpt-5.3-codex": { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },

  // Google and xAI
  "google/gemini-3.6-flash": { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 },
  "google/gemini-3.5-flash": { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 },
  "google/gemini-3.5-flash-lite": {
    input: 0.3,
    output: 2.5,
    cacheRead: 0.03,
    cacheWrite: 0,
  },
  "google/gemini-3.1-flash-lite": {
    input: 0.25,
    output: 1.5,
    cacheRead: 0.03,
    cacheWrite: 0,
  },
  "xai/grok-4.5": { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
};

export const TEMPORARY_PRICING: readonly TemporaryPricing[] = [
  {
    models: ["gpt-5.6-terra", "gpt-5.6-luna"],
    expiresOn: "2026-08-14",
    description: "50% promotional rates",
  },
  {
    models: ["claude-sonnet-5"],
    expiresOn: "2026-08-31",
    description: "introductory pricing",
  },
];

// ── Model catalog: fetch + cache (build-gw6.2) ─────────────────────

/** Default Command Code provider models endpoint. */
export const DEFAULT_MODELS_URL = "https://api.commandcode.ai/provider/v1/models";

/** Default timeout for a models fetch (ms). */
export const DEFAULT_MODELS_TIMEOUT_MS = 10_000;

/** Cap on maxTokens we advertise per model (the API returns only contextLength). */
const DEFAULT_MAX_OUTPUT_TOKENS = 65_536;

/** Cache file format version — bump to invalidate old caches. */
const MODEL_CACHE_VERSION = 1;

/** Cooldown between network refreshes (ms) — the catalog is stable, 10s is plenty. */
export const REFRESH_COOLDOWN_MS = 10_000;

interface ApiModel {
  id: string;
  name: string;
  contextLength: number;
}

export interface FetchCommandCodeModelsOptions {
  url?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface LoadCommandCodeModelsOptions extends FetchCommandCodeModelsOptions {
  /** Absolute path to the cache file (e.g. <agentDir>/commandcode-models.json). */
  cachePath: string;
}

/**
 * Result of loading the catalog. `source` tells the caller whether the models
 * came from the live API, the local cache (live failed), or nothing at all.
 * `warning` is human-readable and non-fatal (callers log it, they don't throw).
 */
export interface LoadCommandCodeModelsResult {
  models: readonly CommandCodeModel[];
  source: "live" | "cache" | "empty";
  warning?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${key} to be a non-empty string`);
  }
  return value;
}

function booleanField(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`Expected ${key} to be a boolean`);
  return value;
}

function positiveNumberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Expected ${key} to be a positive number`);
  }
  return value;
}

function parseApiModel(value: unknown): ApiModel {
  if (!isRecord(value)) throw new Error("Expected model entry to be an object");
  return {
    id: stringField(value, "id"),
    name: stringField(value, "name"),
    contextLength: positiveNumberField(value, "context_length"),
  };
}

function parseCachedModel(value: unknown): CommandCodeModel {
  if (!isRecord(value)) throw new Error("Expected cached model entry to be an object");

  const id = stringField(value, "id");
  booleanField(value, "reasoning");
  return {
    id,
    name: stringField(value, "name"),
    // trust our static table, not the cached flag (cache may be older than the table)
    reasoning: isReasoningModel(id),
    contextWindow: positiveNumberField(value, "contextWindow"),
    maxTokens: positiveNumberField(value, "maxTokens"),
  };
}

function requireModels(models: readonly CommandCodeModel[]): readonly CommandCodeModel[] {
  if (models.length === 0) throw new Error("Command Code returned an empty model catalog");
  return models;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new DOMException("The operation was aborted", "AbortError");
}

function configuredTimeoutMs(timeoutMs: number | undefined): number {
  return timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_MODELS_TIMEOUT_MS;
}

/** COMMANDCODE_MODELS_TIMEOUT_MS env override, else 10s. */
export function getModelsTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.COMMANDCODE_MODELS_TIMEOUT_MS;
  if (!raw) return DEFAULT_MODELS_TIMEOUT_MS;
  const parsed = Number(raw);
  return configuredTimeoutMs(parsed);
}

class ModelDiscoveryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Command Code model discovery timed out after ${timeoutMs}ms`);
    this.name = "ModelDiscoveryTimeoutError";
  }
}

/**
 * Run `operation` with an internal AbortController that fires when
 * `timeoutMs` elapses or `externalSignal` aborts (whichever first).
 * The internal signal is aborted with the timeout error so fetch() rejects.
 */
function runWithTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let onExternalAbort: (() => void) | undefined;

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (onExternalAbort && externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    };

    const resolveOnce = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const abort = (reason: unknown) => {
      const error = abortError(reason);
      controller.abort(error);
      rejectOnce(error);
    };

    if (externalSignal?.aborted) {
      abort(externalSignal.reason);
      return;
    }

    onExternalAbort = () => abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    timer = setTimeout(() => abort(new ModelDiscoveryTimeoutError(timeoutMs)), timeoutMs);

    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(resolveOnce, rejectOnce);
  });
}

/**
 * Validate a raw /models API response (`{ object: "list", data: [...] }`)
 * into CommandCodeModel[]. Throws on malformed payloads.
 */
export function commandCodeModelsFromApiResponse(value: unknown): readonly CommandCodeModel[] {
  if (!isRecord(value)) throw new Error("Expected models response to be an object");
  if (value.object !== "list") throw new Error("Expected models response object to be 'list'");

  const data = value.data;
  if (!Array.isArray(data)) throw new Error("Expected models response data to be an array");

  return data.map(parseApiModel).map((model) => ({
    id: model.id,
    name: `${model.name} (CC)`,
    reasoning: isReasoningModel(model.id),
    contextWindow: model.contextLength,
    maxTokens: Math.min(model.contextLength, DEFAULT_MAX_OUTPUT_TOKENS),
  }));
}

/** Validate a cache file payload (`{ version, models }`) into CommandCodeModel[]. */
export function commandCodeModelsFromCache(value: unknown): readonly CommandCodeModel[] {
  if (!isRecord(value)) throw new Error("Expected model cache to be an object");
  if (value.version !== MODEL_CACHE_VERSION) {
    throw new Error(`Expected model cache version ${MODEL_CACHE_VERSION}`);
  }
  if (!Array.isArray(value.models)) throw new Error("Expected cached models to be an array");

  return requireModels(value.models.map(parseCachedModel));
}

/**
 * GET /provider/v1/models with a 10s timeout + abort support. Returns the
 * validated catalog. Throws on HTTP errors, malformed bodies, or timeout.
 */
export async function fetchCommandCodeModels(
  options: FetchCommandCodeModelsOptions = {},
): Promise<readonly CommandCodeModel[]> {
  const url = options.url ?? DEFAULT_MODELS_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const body: unknown = await runWithTimeout(
    async (signal) => {
      const response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        signal,
      });
      if (!response.ok) {
        throw new Error(
          `Failed to fetch Command Code models: ${response.status} ${response.statusText}`,
        );
      }
      return await response.json();
    },
    configuredTimeoutMs(options.timeoutMs),
    options.signal,
  );
  return requireModels(commandCodeModelsFromApiResponse(body));
}

async function readCommandCodeModelsCache(cachePath: string): Promise<readonly CommandCodeModel[]> {
  const contents = await readFile(cachePath, "utf-8");
  const parsed: unknown = JSON.parse(contents);
  return commandCodeModelsFromCache(parsed);
}

/**
 * ATOMIC cache write: write to a temp file in the same dir, fsync-free,
 * then rename() over the target. rename() is atomic on the same filesystem,
 * so readers never see a half-written JSON (they see either the old file
 * or the new one). Temp file is cleaned up even if the write throws.
 * Mode 0o600 so the catalog (model ids/names) stays user-only.
 */
async function writeCommandCodeModelsCache(
  cachePath: string,
  models: readonly CommandCodeModel[],
): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.${process.pid}.tmp`;

  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ version: MODEL_CACHE_VERSION, models }, null, 2)}\n`,
      { encoding: "utf-8", mode: 0o600 },
    );
    await rename(temporaryPath, cachePath);
  } finally {
    try {
      await rm(temporaryPath, { force: true });
    } catch {
      // Best-effort cleanup must not hide the original cache write error.
    }
  }
}

/**
 * Load the catalog: try the live API, fall back to the cache file, else empty.
 * Live failures degrade gracefully: cache gives a warning, empty gives one too.
 */
export async function loadCommandCodeModels(
  options: LoadCommandCodeModelsOptions,
): Promise<LoadCommandCodeModelsResult> {
  const cachePath = options.cachePath;

  try {
    const models = await fetchCommandCodeModels(options);

    try {
      await writeCommandCodeModelsCache(cachePath, models);
      return { models, source: "live" };
    } catch (error) {
      return {
        models,
        source: "live",
        warning: `Loaded the live Command Code model catalog but could not update ${cachePath}: ${errorMessage(error)}`,
      };
    }
  } catch (liveError) {
    if (options.signal?.aborted) throw abortError(options.signal.reason ?? liveError);

    try {
      const models = await readCommandCodeModelsCache(cachePath);
      return {
        models,
        source: "cache",
        warning: `Could not refresh the Command Code model catalog (${errorMessage(liveError)}). Using the cached catalog from ${cachePath}.`,
      };
    } catch (cacheError) {
      return {
        models: [],
        source: "empty",
        warning: `Could not refresh the Command Code model catalog (${errorMessage(liveError)}), and no valid cached catalog is available at ${cachePath} (${errorMessage(cacheError)}). Command Code models will remain unavailable until a refresh succeeds.`,
      };
    }
  }
}

/**
 * COALESCED refresh: if a refresh is already in flight, return THE SAME
 * promise so concurrent callers share one network request instead of N.
 * When the shared promise settles it is cleared, so a LATER call starts fresh.
 */
export function coalescedRefresh(
  cachePath: string,
  options: FetchCommandCodeModelsOptions = {},
): Promise<LoadCommandCodeModelsResult> {
  if (!refreshInFlight) {
    refreshInFlight = loadCommandCodeModels({ cachePath, ...options }).finally(() => {
      if (refreshInFlight === inFlightPromise) refreshInFlight = undefined;
    });
  }
  return refreshInFlight;
}

// module-level shared state for coalescedRefresh
let refreshInFlight: Promise<LoadCommandCodeModelsResult> | undefined;
let inFlightPromise: Promise<LoadCommandCodeModelsResult> | undefined;

// ── Single namespace export ────────────────────────────────────────

/** Flat namespace so index.ts / tests can import one object. */
export const COMMAND_CODE = {
  MODEL_INPUT_MODALITIES,
  MODEL_EFFORTS,
  PI_THINKING_LEVELS,
  MODEL_COSTS,
  TEMPORARY_PRICING,
  ZERO_MODEL_COST,
  PRICING_SOURCE_URL,
  PRICING_LAST_VERIFIED,
  DEFAULT_MODELS_URL,
  DEFAULT_MODELS_TIMEOUT_MS,
  REFRESH_COOLDOWN_MS,
  fetchCommandCodeModels,
  loadCommandCodeModels,
  coalescedRefresh,
  commandCodeModelsFromApiResponse,
  commandCodeModelsFromCache,
  getModelsTimeoutMs,
} as const;
