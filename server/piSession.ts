// piSession.ts — intermediary between the pi agent (the actual harness that runs) and our prompt.
//
// This is the only file that talks to the pi agent runtime. Durable state
// (history, model, thinking level) lives in SQLite; here we read it when a
// conversation opens and keep the agent session in memory until it is closed.
//
// Used by:
//   index.ts            create() once at startup, disposeAll() at shutdown
//   routes/chat.ts      open(key, dir) to run a turn
//   routes/sessions.ts  getModels() / getZdr() / setZdr()
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { StateStore, Message } from "./stateStore.ts";
import { fetchModels, inputModalitiesForModel, thinkingLevelMapForModel, DEFAULT_MODEL_ID, type CommandCodeModel, type ModelCatalogEntry } from "./commandCode.ts";

/** Command Code provider URL (OpenAI-compatible). Tests can override with COMMANDCODE_API_BASE. */
const COMMANDCODE_API_BASE = process.env.COMMANDCODE_API_BASE ?? "https://api.commandcode.ai/provider/v1";

/** One open conversation, returned by open(). */
export interface SessionHandle {
  sessionKey: string;
  /** The model this session runs. Changing the model rebuilds the handle. */
  modelId: string;
  /** The pi agent session itself (relay.ts subscribes to it). */
  session: {
    subscribe(cb: (ev: unknown) => void): () => void;
    prompt(text: string): Promise<void>;
    abort(): Promise<void>;
    setThinkingLevel(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"): void;
    dispose(): void;
  };
  /** Close the session and remove it from the manager's cache. */
  dispose(): void;
}

/** pi's message shape, used to seed a resumed session's history. */
interface AgentMessageLike {
  role: "user" | "assistant";
  content: string | { type: "text"; text: string }[];
  timestamp: number;
  api?: string;
  provider?: string;
  model?: string;
  usage?: unknown;
  stopReason?: string;
}

/**
 * Settings for create().
 * agentDir = isolated pi config directory (never ~/.pi/agent).
 * cwd = default working directory for a project.
 */
export interface PiSessionManagerOpts {
  agentDir: string;
  cwd: string;
  modelProvider?: string;
  modelId?: string;
  extensions: {
    /** Files to load as pi extensions. */
    paths: string[];
    /** Tools those extensions add to every session. */
    toolNames: string[];
  };
}

/** Keeps one open pi session per conversation key. */
export class PiSessionManager {
  private modelRuntime: ModelRuntime;
  private loader: DefaultResourceLoader;
  private store: StateStore;
  private handles = new Map<string, SessionHandle>();
  private modelProvider: string;
  private modelId: string;
  /** Model catalog fetched at startup; served to the UI by getModels(). */
  private models: CommandCodeModel[] = [];
  /** Global zero-data-retention switch (on by default). */
  private zdrEnabled = true;

  private constructor(store: StateStore, private opts: PiSessionManagerOpts) {
    this.store = store;
    this.modelProvider = opts.modelProvider ?? "command-code";
    // The default model must be in CURATED_MODELS, or open() cannot resolve it.
    this.modelId = opts.modelId ?? DEFAULT_MODEL_ID;
  }

  static async create(store: StateStore, opts: PiSessionManagerOpts): Promise<PiSessionManager> {
    const m = new PiSessionManager(store, opts); // this calls for the private constructor above. Not the class.
    await m.init();
    return m;
  }

  /** Runs once at startup, before any session is created: registers the provider and loads extensions. */
  private async init() {
    this.modelRuntime = await ModelRuntime.create();
    await this.registerCommandCode();
    await this.modelRuntime.setRuntimeApiKey("command-code", process.env.COMMANDCODE_API_KEY ?? "");

    this.loader = new DefaultResourceLoader({
      agentDir: this.opts.agentDir,
      cwd: this.opts.cwd,
      additionalExtensionPaths: this.opts.extensions.paths,
    });
    await this.loader.reload();
    // A failed extension is not fatal: the agent just has fewer tools.
    for (const { path, error } of this.loader.getExtensions().errors) {
      console.error(`[extensions] failed to load ${path}: ${error}`);
    }
  }

  /** Register the provider with the latest model catalog and ZDR header. */
  private async registerCommandCode() {
    let models: CommandCodeModel[] = [];
    try {
      models = await fetchModels(`${COMMANDCODE_API_BASE}/models`);
    } catch (err) {
      console.error("[command-code] model fetch failed:", err);
    }
    this.models = models; // keep the catalog for getModels()
    this.modelRuntime.registerProvider("command-code", {
      name: "Command Code",
      baseUrl: COMMANDCODE_API_BASE,
      apiKey: "",
      api: "openai-completions",
      // {} clears the ZDR header; undefined would keep the previous one.
      headers: this.zdrEnabled ? { "x-cmd-zdr": "1" } : {},
      models: models.map((m) => ({
        id: m.id,
        name: m.name,
        reasoning: m.reasoning,
        thinkingLevelMap: thinkingLevelMapForModel(m.id),
        input: [...inputModalitiesForModel(m.id)],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        compat: m.compat,
      })),
    });
  }

  /** Turn zero-data-retention on/off for every request (re-registers the provider). */
  async setZdr(enabled: boolean) {
    this.zdrEnabled = enabled;
    await this.registerCommandCode();
  }

  /** Current zero-data-retention state, for the UI. */
  getZdr(): boolean {
    return this.zdrEnabled;
  }

  /**
   * The model list served by GET /api/models.
   * thinkingLevelMap is not in the provider API, so it comes from the curated
   * table in commandCode.ts.
   */
  getModels(): ModelCatalogEntry[] {
    return this.models.map((m) => ({
      id: m.id,
      name: m.name,
      thinkingLevelMap: thinkingLevelMapForModel(m.id),
      input: inputModalitiesForModel(m.id),
    }));
  }

  /** The registered model object for an id; throws if it is unknown. */
  private resolveModel(modelId: string): ReturnType<ModelRuntime["getModel"]> {
    const model = this.modelRuntime.getModel(this.modelProvider, modelId);
    if (!model) throw new Error(`model not found: ${this.modelProvider}/${modelId}`);
    return model;
  }

  /** Converts stored Message rows into pi's message shape, for history seeding. */
  private toAgentMessages(history: Message[]): AgentMessageLike[] {
    return history.map((m) =>
      m.role === "user"
        ? { role: "user", content: m.text, timestamp: m.timestamp }
        : {
            role: "assistant",
            content: [{ type: "text", text: m.text }],
            timestamp: m.timestamp,
            api: "openai-completions",
            provider: this.modelProvider,
            model: this.modelId,
            usage: {},
            stopReason: "stop",
          },
    );
  }

  /**
   * Return the open session for a conversation, creating it if needed.
   * History from SQLite is loaded on first open so the agent has context.
   * @param sessionKey e.g. "agent:<projectId>:<thread>"
   * @param projectDir working directory for the agent's tools
   */
  async open(sessionKey: string, projectDir: string): Promise<SessionHandle> {
    // Resolve the model before checking the cache, so a model change is noticed.
    // Fall back to the default when the stored model is unset or no longer offered.
    const stored = this.store.getSession(sessionKey);
    const modelId = stored?.modelId && this.models.some((m) => m.id === stored.modelId)
      ? stored.modelId
      : this.modelId;

    const existing = this.handles.get(sessionKey);
    // Same model: reuse the in-memory session, applying the latest thinking level.
    if (existing && existing.modelId === modelId) {
      existing.session.setThinkingLevel((stored?.thinkingLevel ?? "off") as Parameters<typeof existing.session.setThinkingLevel>[0]);
      return existing;
    }
    // Different model: drop the old session and rebuild it with fresh history.
    if (existing) existing.dispose();

    const history = this.store.getMessages(sessionKey);
    const model = this.resolveModel(modelId);

    const { session } = await createAgentSession({
      modelRuntime: this.modelRuntime,
      resourceLoader: this.loader,
      sessionManager: SessionManager.inMemory(),
      cwd: projectDir,
      model,
      tools: ["read", "bash", "write", "edit", ...this.opts.extensions.toolNames], // core tools + extension tools
    });

    // "off" unless the conversation stored a level; setThinkingLevel clamps it.
    const level = (stored?.thinkingLevel ?? "off") as Parameters<typeof session.setThinkingLevel>[0];
    session.setThinkingLevel(level);

    // Seed stored history so the next prompt continues the conversation.
    if (history.length > 0) {
      session.agent.state.messages = this.toAgentMessages(history) as never;
    }

    const handle: SessionHandle = {
      sessionKey,
      modelId,
      session,
      dispose: () => { //exists for caching purposes
        session.dispose();
        this.handles.delete(sessionKey);
      },
    };
    this.handles.set(sessionKey, handle);
    return handle;
  }

  /** Close every open session (called on shutdown). */
  disposeAll() {
    for (const h of [...this.handles.values()]) h.dispose();
  }

  /** Close one conversation's session (called when it is deleted). */
  dispose(sessionKey: string): void {
    this.handles.get(sessionKey)?.dispose();
  }
}
