// commandCode.ts — our curated view of the Command Code provider.
//
// Opinionated on purpose. The provider serves ~70 models; we offer the three in
// CURATED_MODELS below.
// 
// The live /models fetch supplies each model's name and context window
// (the API knows those, so they stay current), while a curated row carries only what
// the API does not expose — that the model exists for us at all, what it accepts, and
// the thinking levels it takes.
//
// To add a model: add a row using the exact live id, take `efforts` from the
// provider's generated `commandcode-catalog.ts`, and confirm it shows up in
// GET /api/models. Nothing else changes.
//
export type CommandCodeInputType = "text" | "image";

export type CommandCodeReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** pi's thinking ladder. "off" is the absence of thinking, never an effort. */
export type PiThinkingLevel = "off" | CommandCodeReasoningEffort;

/** The ladder without "off" — pi's thinkingLevelMap never carries "off". */
const THINKING_LEVELS: readonly CommandCodeReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** A model we offer: what it accepts, and the thinking levels it takes. */
interface CuratedModel {
  input: readonly CommandCodeInputType[];
  /** Selectable reasoning efforts; an empty list means the model does not reason. */
  efforts: readonly CommandCodeReasoningEffort[];
}

/** The only models this app offers. Ids must be exact, live Command Code ids. */
export const CURATED_MODELS: Readonly<Record<string, CuratedModel>> = {
  "deepseek/deepseek-v4.1-flash": { input: ["text", "image"], efforts: ["low", "high", "max"] },
  "z-ai/glm-5.3-flash": { input: ["text", "image"], efforts: ["low", "high", "max"] },
  "meta/muse-spark-1.3-contributor": {
    input: ["text", "image"],
    efforts: ["low", "medium", "high", "xhigh"],
  },
};

/** The model a conversation starts on when nothing else is stored. Must be curated. */
export const DEFAULT_MODEL_ID = "deepseek/deepseek-v4.1-flash";

// ── Model shapes ───────────────────────────────────────────────────

/** A model as fetched from the provider, after curation. */
export interface CommandCodeModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

/** A model as served to the UI by `GET /api/models`. */
export interface ModelCatalogEntry {
  id: string;
  name: string;
  /** undefined when the model does not reason. */
  thinkingLevelMap: Partial<Record<PiThinkingLevel, string | null>> | undefined;
  input: readonly CommandCodeInputType[];
}

// ── Curated lookups ────────────────────────────────────────────────

/** Modalities a model accepts. Non-curated ids never reach here; they default to text. */
export function inputModalitiesForModel(modelId: string): readonly CommandCodeInputType[] {
  return CURATED_MODELS[modelId]?.input ?? ["text"];
}

/**
 * pi's `Model.thinkingLevelMap`, built from the curated row: each ladder level maps to
 * the effort to send, or to null when the model does not support it. Undefined when the
 * model does not reason at all.
 *
 * This is the only thinking shape pi reads (an effortMap/mode object does nothing), and
 * it is also what `GET /api/models` hands the composer pill.
 */
export function thinkingLevelMapForModel(
  modelId: string,
): Partial<Record<PiThinkingLevel, string | null>> | undefined {
  const efforts = CURATED_MODELS[modelId]?.efforts;
  if (!efforts?.length) return undefined;
  const map: Partial<Record<PiThinkingLevel, string | null>> = {};
  for (const level of THINKING_LEVELS) {
    map[level] = efforts.includes(level) ? level : null;
  }
  return map;
}

// ── Fetch (build-gw6.2) ────────────────────────────────────────────

/** Default Command Code provider models endpoint. */
export const DEFAULT_MODELS_URL = "https://api.commandcode.ai/provider/v1/models";

/** Default timeout for a models fetch (ms). */
export const DEFAULT_MODELS_TIMEOUT_MS = 10_000;

/** Cap on maxTokens we advertise per model (the API returns only context length). */
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
 * GET /provider/v1/models → the curated models the provider still serves.
 *
 * Throws on HTTP error, malformed body, timeout, abort, or when not one curated id
 * exists any more (which means CURATED_MODELS has gone stale, not that the provider is
 * down). No file cache, no fallback — the caller holds the result in memory (gw6.4).
 */
export async function fetchModels(options: FetchModelsOptions = {}): Promise<CommandCodeModel[]> {
  const url = options.url ?? DEFAULT_MODELS_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = options.signal ?? AbortSignal.timeout(options.timeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS);

  const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal });
  if (!response.ok) {
    throw new Error(`Failed to fetch Command Code models: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as { data?: unknown };
  if (!Array.isArray(body.data)) {
    throw new Error("Expected Command Code models response to be { object: 'list', data: [...] }");
  }

  const models = (body.data as unknown[])
    .map((entry): CommandCodeModel => {
      const record = entry as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : "";
      const contextWindow = typeof record.context_length === "number" ? record.context_length : 0;
      if (!id || contextWindow <= 0) {
        throw new Error("Expected model entry to have a non-empty id and positive context_length");
      }
      return {
        id,
        name: typeof record.name === "string" ? record.name : id,
        reasoning: (CURATED_MODELS[id]?.efforts.length ?? 0) > 0,
        contextWindow,
        maxTokens: Math.min(contextWindow, DEFAULT_MAX_OUTPUT_TOKENS),
      };
    })
    .filter((model) => model.id in CURATED_MODELS);

  if (models.length === 0) {
    throw new Error(`None of the curated models exist any more: ${Object.keys(CURATED_MODELS).join(", ")}`);
  }
  return models;
}
