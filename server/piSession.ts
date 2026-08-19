// piSession.ts — the session manager: open / RESUME a conversation's AgentSession.
//
// Responsibilities (step 4 scope):
//   - one AgentSession per conversation key (open once, reuse)
//   - right cwd (= project dir for execution), model, and tools
//   - RESUME = seed the session's history from the store so a follow-up
//     prompt has context (session.agent.state.messages = restored messages)
//   - isolated: custom agentDir so we never touch ~/.pi/agent
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
//   The manager holds one AgentSession per conversation key in `handles`.
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { GENERATED_MODELS } from "pi-ollama-cloud/models.generated.ts";
import { OLLAMA_BASE, refreshOllamaCatalog } from "pi-ollama-cloud/models.ts";
import type { StateStore, Message } from "./stateStore.ts";

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

  private constructor(store: StateStore, private opts: PiSessionManagerOpts) {
    this.store = store;
    this.modelProvider = opts.modelProvider ?? "ollama-cloud";
    // Model id must match an entry in GENERATED_MODELS (pi-ollama-cloud).
    // "deepseek-v4-flash:cloud" does NOT exist — the "cloud" bit is the provider,
    // not the model. Options: deepseek-v4-flash:0731 | deepseek-v4-flash:preview | deepseek-v4-pro
    this.modelId = opts.modelId ?? "deepseek-v4-flash:0731";
  }

  /**
   * Factory. Called once by index.ts at startup. Runs init() to register the
   * ollama-cloud provider + credential and build the resource loader.
   */
  static async create(store: StateStore, opts: PiSessionManagerOpts): Promise<PiSessionManager> {
    const m = new PiSessionManager(store, opts);
    await m.init();
    return m;
  }

  /**
   * Register the ollama-cloud provider + credential once, per process.
   * Internal — called by create(). Must run BEFORE any session is created
   * (model selection happens before extensions bind).
   */
  private async init() {
    this.modelRuntime = await ModelRuntime.create();
    this.modelRuntime.registerProvider("ollama-cloud", {
      name: "Ollama Cloud",
      baseUrl: `${OLLAMA_BASE}/v1`,
      apiKey: "",
      api: "openai-completions",
      models: GENERATED_MODELS,
      refreshModels: refreshOllamaCatalog,
    });
    await this.modelRuntime.setRuntimeApiKey("ollama-cloud", process.env.OLLAMA_API_KEY ?? "");

    this.loader = new DefaultResourceLoader({ agentDir: this.opts.agentDir, cwd: this.opts.cwd });
    await this.loader.reload();
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
