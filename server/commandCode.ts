// commandCode.ts — our curated view of the Command Code provider.
//
// Opinionated on purpose. The provider serves ~80 models; we offer the three in
// CURATED_MODELS below.
//
// The live catalog is fetched with loadModels() from the official
// @commandcode/pi-commandcode-provider package, which maps each entry to a pi
// model (route pinning, request-shape compat fixes, capability metadata). The
// curated row then carries only what that mapping cannot know — that the model
// exists for us at all, what it accepts, and the thinking levels it takes.
//
// To add a model: add a row using the exact live id, take `efforts` from the
// provider's generated `commandcode-catalog.ts`, and confirm it shows up in
// GET /api/models. Nothing else changes.
//
import { loadModels } from "@commandcode/pi-commandcode-provider";

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

/** A model as returned by the official package's loadModels(). */
type LoadedModel = Awaited<ReturnType<typeof loadModels>>[number];

/** A model as fetched from the provider, after curation. */
export interface CommandCodeModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  /** Request-shape fixes from the official mapping (system role, max_tokens field). */
  compat: LoadedModel["compat"];
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

// ── Fetch ──────────────────────────────────────────────────────────

/** Command Code provider models endpoint. */
export const DEFAULT_MODELS_URL = "https://api.commandcode.ai/provider/v1/models";

/**
 * GET /provider/v1/models → the curated models the provider still serves.
 *
 * loadModels() (official package) does the fetching and the mapping; we only
 * filter to our curated ids and copy the fields this app uses.
 *
 * Throws on HTTP error, timeout, or when no curated id exists any more (which

 * means CURATED_MODELS has gone stale, not that the provider is down). No file
 * cache, no fallback — the caller holds the result in memory (gw6.4).
 *
 * m.headers is deliberately NOT copied: with CMD_ZDR=1 in the environment the
 * official mapping bakes x-cmd-zdr onto every model, which would make ZDR-on
 * sticky. Our ZDR toggle owns that header at the provider level (piSession).
 */
export async function fetchModels(url = DEFAULT_MODELS_URL): Promise<CommandCodeModel[]> {
  const models = (await loadModels(url))
    .filter((m) => m.id in CURATED_MODELS)
    .map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      compat: m.compat,
    }));

  if (models.length === 0) {
    throw new Error(`None of the curated models exist any more: ${Object.keys(CURATED_MODELS).join(", ")}`);
  }
  return models;
}
