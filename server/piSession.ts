// piSession.ts — the session manager: open / RESUME a conversation's AgentSession.
//
// Responsibilities (step 4 scope):
//   - one AgentSession per conversation key (open once, reuse)
//   - right cwd (= project dir for execution), model, and tools
//   - RESUME = seed the session's history from the store so a follow-up
//     prompt has context (session.agent.state.messages = restored messages)
//   - isolated: custom agentDir so we never touch ~/.pi/agent
//
// Provider: Command Code (command-code). Models are fetched live at startup
// (fetchModels, in-memory, no fallback); the default model is deepseek-v4-flash.
// ZDR (zero data retention) is a GLOBAL toggle: when on, every request carries
// the x-cmd-zdr: 1 header (re-registers the provider — no restart needed).
//
// The relay (relay.ts) handles event capture + persistence; it subscribes to
// the session this manager opens.
//
// ── FLOW (who calls what) ─────────────────────────────────────────────
//   index.ts (entry, build-5ei):
//     const manager = await PiSessionManager.create(store, { agentDir, cwd })
//     ... on shutdown: manager.disposeAll()
//   chat.ts (WS route, build-cqf):
//     const handle = await manager.open(sessionKey, projectDir)  // per prompt
//     const relay = attachAssistantRelay(store, key, handle.session)
//     await handle.session.prompt(text)
//   routes/sessions.ts (ZDR):
//     POST /api/sessions/zdr → manager.setZdr(bool) → re-register provider
//   The manager holds one AgentSession per conversation key in `handles`.
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { StateStore, Message } from "./stateStore.ts";
import { fetchModels, inputModalitiesForModel, thinkingMetadataForModel, type CommandCodeModel } from "./commandCode.ts";

/** Command Code Provider API base (OpenAI-compatible). Env override for tests. */
const COMMANDCODE_API_BASE = process.env.COMMANDCODE_API_BASE ?? "https://api.commandcode.ai/provider/v1";

/**
 * What open() returns. Consumed by chat.ts (and relay.ts, which subscribes to
 * `handle.session`). `dispose()` closes the session and removes it from the
 * manager's map.
 */
export interface SessionHandle {
  sessionKey: string;
  /** The raw AgentSession (relay/test subscribes to it). */
  session: {
    subscribe(cb: (ev: unknown) => void): () => void;
    prompt(text: string): Promise<void>;
    abort(): Promise<void>;
    dispose(): void;
  };
  dispose(): void;
}

/**
 * pi's message shape, used to seed a resumed session's history.
 * Internal — produced by toAgentMessages() from store Message[] rows.
 */
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
 * Config for PiSessionManager.create(). Supplied by index.ts.
 * agentDir = isolated pi config dir (never ~/.pi/agent); cwd = default
 * project dir for execution.
 */
export interface PiSessionManagerOpts {
  agentDir: string;
  cwd: string;
  modelProvider?: string;
  modelId?: string;
}

/**
 * The session manager. Created ONCE at startup (index.ts). Holds one
 * AgentSession per conversation key; open() creates or reuses.
 */
export class PiSessionManager {
  private modelRuntime: ModelRuntime;
  private loader: DefaultResourceLoader;
  private store: StateStore;
  private handles = new Map<string, SessionHandle>();
  private modelProvider: string;
  private modelId: string;
  /** Global ZDR (zero data retention) state. On by default. */
  private zdrEnabled = true;

  private constructor(store: StateStore, private opts: PiSessionManagerOpts) {
    this.store = store;
    this.modelProvider = opts.modelProvider ?? "command-code";
    // Must match a live Command Code model id (e.g. "deepseek/deepseek-v4-flash").
    this.modelId = opts.modelId ?? "deepseek/deepseek-v4-flash";
  }

  /**
   * Factory. Called once by index.ts at startup. Runs init() to register the
   * command-code provider + credential and build the resource loader.
   */
  static async create(store: StateStore, opts: PiSessionManagerOpts): Promise<PiSessionManager> {
    const m = new PiSessionManager(store, opts);
    await m.init();
    return m;
  }

  /**
   * Register the command-code provider + credential once, per process.
   * Internal — called by create(). Must run BEFORE any session is created
   * (model selection happens before extensions bind).
   */
  private async init() {
    this.modelRuntime = await ModelRuntime.create();
    await this.registerCommandCode();
    await this.modelRuntime.setRuntimeApiKey("command-code", process.env.COMMANDCODE_API_KEY ?? "");

    this.loader = new DefaultResourceLoader({ agentDir: this.opts.agentDir, cwd: this.opts.cwd });
    await this.loader.reload();
  }

  /**
   * (Re-)register the command-code provider with the live model catalog.
   * The ZDR header is a provider-level header (like the upstream extension's
   * COMMANDCODE_ZDR=1), so toggling ZDR just re-registers — the runtime merges
   * over the previous config and keeps the apiKey.
   */
  private async registerCommandCode() {
    let models: CommandCodeModel[] = [];
    try {
      models = await fetchModels({ url: `${COMMANDCODE_API_BASE}/models` });
    } catch (err) {
      console.error("[command-code] model fetch failed:", err);
    }
    this.modelRuntime.registerProvider("command-code", {
      name: "Command Code",
      baseUrl: COMMANDCODE_API_BASE,
      apiKey: "",
      api: "openai-completions",
      headers: this.zdrEnabled ? { "x-cmd-zdr": "1" } : undefined,
      models: models.map((m) => ({
        id: m.id,
        name: m.name,
        reasoning: m.reasoning,
        ...(thinkingMetadataForModel(m.id) ?? {}),
        input: [...inputModalitiesForModel(m.id)],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
      })),
    });
  }

  /**
   * Global ZDR toggle. When on, every request carries x-cmd-zdr: 1
   * (zero data retention). Re-registers the provider so the change applies
   * to the next request — no restart needed.
   */
  async setZdr(enabled: boolean) {
    this.zdrEnabled = enabled;
    await this.registerCommandCode();
  }

  /** Current global ZDR state (for the UI). */
  getZdr(): boolean {
    return this.zdrEnabled;
  }

  /**
   * Resolve the configured model object from the runtime.
   * Internal — used by open() when creating a session.
   */
  private resolveModel(): ReturnType<ModelRuntime["getModel"]> {
    const model = this.modelRuntime.getModel(this.modelProvider, this.modelId);
    if (!model) throw new Error(`model not found: ${this.modelProvider}/${this.modelId}`);
    return model;
  }

  /**
   * Convert store history to AgentMessage[] (pi's message shape).
   * Internal — used by open() to seed a resumed session.
   */
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
   * Open a conversation. If already open, returns the existing handle.
   * If the conversation has prior messages, seeds the session with them (resume).
   * Called by chat.ts per prompt.
   * @param sessionKey e.g. "agent:main:1"
   * @param projectDir execution cwd (the project's working directory)
   */
  async open(sessionKey: string, projectDir: string): Promise<SessionHandle> {
    const existing = this.handles.get(sessionKey);
    if (existing) return existing;

    const history = this.store.getMessages(sessionKey);

    const { session } = await createAgentSession({
      modelRuntime: this.modelRuntime,
      resourceLoader: this.loader,
      sessionManager: SessionManager.inMemory(),
      cwd: projectDir,
      model: this.resolveModel(),
      tools: ["read", "bash", "write", "edit"], // main agent tools
    });

    // RESUME: seed prior conversation history so the next prompt has context
    if (history.length > 0) {
      session.agent.state.messages = this.toAgentMessages(history) as never;
    }

    const handle: SessionHandle = {
      sessionKey,
      session,
      dispose: () => {
        session.dispose();
        this.handles.delete(sessionKey);
      },
    };
    this.handles.set(sessionKey, handle);
    return handle;
  }

  /**
   * Close every open session. Called by index.ts on graceful shutdown.
   */
  disposeAll() {
    for (const h of [...this.handles.values()]) h.dispose();
  }
}
