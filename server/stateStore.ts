// stateStore.ts — event-sourcing + projections, logic copied from t3code
// (apps/server/src/persistence/* + apps/server/src/orchestration/*).
//
// Model: an append-only `orchestration_events` log is the source of truth;
// denormalized `projection_*` read models are rebuilt from it via upserts.
// The user prompt is persisted BEFORE the engine runs (awaited, in a
// transaction), then published to the in-memory bus post-commit.
//
// Uses node:sqlite (built-in, requires Node >= 22.5).
//
// ── FLOW (who calls what) ─────────────────────────────────────────────
//   index.ts (entry, build-5ei):
//     const store = new StateStore(dbPath); store.rebuildProjections();
//     ... on shutdown: store.close()
//   relay.ts (writes): store.write({...})  — user prompt + assistant deltas
//   routes (build-spi, reads): getProjects / getSessions / getMessages / getInbox
//   piSession.ts (reads): store.getMessages(key)  — to seed a resumed session
//   The store is the single object that owns ALL database access.

import { DatabaseSync } from "node:sqlite";

// ── Domain types (mirror contracts.md) ──────────────────────────────

/** Project / conversation lifecycle state. Used by both Project and Session. */
export type State = "active" | "deferred" | "done";

/** A project = its own agent + working dir. Read by routes; written via write(). */
export interface Project {
  id: string;
  name: string;
  emoji?: string;
  dir: string;
  state: State;
  createdAt: number;
  updatedAt: number;
}

/** A conversation inside a project. Read by routes; written via write(). */
export interface Session {
  key: string; // "agent:<projectId>:<thread>"
  name: string;
  projectId: string;
  state: State;
  noInbox: boolean;
  lastTouchedAt: number | null;
  /** Stored model slug (e.g. "deepseek/deepseek-v4-flash"). null → manager default. */
  modelId?: string | null;
  /** Stored thinking level (off|minimal|low|medium|high|xhigh|max). null → "off". */
  thinkingLevel?: string | null;
}

/** One message in a conversation. Read by routes + piSession; written via write(). */
export interface Message {
  id: string;
  sessionKey: string;
  role: "user" | "assistant";
  text: string;
  isStreaming: boolean;
  timestamp: number;
  idx: number;
}

/** One row as stored in the append-only log (flattened, generic). */
export interface EventRow {
  sequence: number;
  eventType: string;
  streamId: string; // sessionKey
  payload: Record<string, unknown>;
  createdAt: number;
}

// ── Event types (contracts §4) ──────────────────────────────────────

/**
 * The typed form of an event your code creates. write() flattens it into an
 * EventRow (eventType = type, payload = payload) and appends it to the log.
 */
export type DomainEvent =
  | { type: "project.created"; payload: { project: Project } }
  | { type: "project.state"; payload: { projectId: string; state: State } }
  | { type: "session.created"; payload: { session: Session } }
  | { type: "session.state"; payload: { sessionKey: string; state: State } }
  | { type: "session.noInbox"; payload: { sessionKey: string; noInbox: boolean } }
  | { type: "session.model"; payload: { sessionKey: string; modelId: string } }
  | { type: "session.thinking"; payload: { sessionKey: string; level: string } }
  | { type: "session.touched"; payload: { sessionKey: string } }
  | { type: "message.sent"; payload: { messageId: string; role: "user" | "assistant"; text: string; streaming?: boolean; sessionKey: string } };

// ── Store ───────────────────────────────────────────────────────────

/**
 * The state store. Created ONCE at startup (index.ts). One open DB connection
 * + a log (append) + projections (apply) + a combined write + cheap reads.
 */
export class StateStore {
  private db: DatabaseSync;

  /** Open the SQLite DB file and create tables if missing. Called by index.ts. */
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.migrate();
  }

  /** Close the DB connection. Called by index.ts on graceful shutdown. */
  close() {
    this.db.close();
  }

  /** Create the 5 tables if they don't exist. Internal — called by constructor. */
  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orchestration_events (
        sequence    INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type  TEXT NOT NULL,
        stream_id   TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_stream ON orchestration_events (stream_id, sequence);

      CREATE TABLE IF NOT EXISTS projection_projects (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        emoji      TEXT,
        dir        TEXT NOT NULL,
        state      TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projection_sessions (
        key            TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        project_id     TEXT NOT NULL,
        state          TEXT NOT NULL,
        no_inbox       INTEGER NOT NULL DEFAULT 0,
        last_touched_at INTEGER,
        model_id       TEXT,
        thinking_level TEXT
      );

      CREATE TABLE IF NOT EXISTS projection_messages (
        id          TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        role        TEXT NOT NULL,
        text        TEXT NOT NULL,
        is_streaming INTEGER NOT NULL,
        timestamp   INTEGER NOT NULL,
        idx         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON projection_messages (session_key, idx);

      CREATE TABLE IF NOT EXISTS projection_state (
        projector             TEXT PRIMARY KEY,
        last_applied_sequence INTEGER NOT NULL
      );
    `);

    // build-gw6.5.1: add per-session model + thinking columns to existing DBs.
    // node:sqlite's SQLite build rejects `ADD COLUMN IF NOT EXISTS`, so guard each
    // ALTER with a PRAGMA table_info check (adding an existing column is an error).
    const existingCols = new Set(
      (this.db.prepare("PRAGMA table_info(projection_sessions)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!existingCols.has("model_id")) {
      this.db.exec("ALTER TABLE projection_sessions ADD COLUMN model_id TEXT");
    }
    if (!existingCols.has("thinking_level")) {
      this.db.exec("ALTER TABLE projection_sessions ADD COLUMN thinking_level TEXT");
    }
  }

  // ── Log (append) ─────────────────────────────────────────────────

  /**
   * Append an event to the log, return its global sequence (AUTOINCREMENT).
   * Low-level — normally you call write() instead. Internal to the store.
   */
  appendEvent(eventType: string, streamId: string, payload: Record<string, unknown>, createdAt = Date.now()): number {
    const row = this.db
      .prepare(
        "INSERT INTO orchestration_events (event_type, stream_id, payload_json, created_at) VALUES (?, ?, ?, ?) RETURNING sequence",
      )
      .get(eventType, streamId, JSON.stringify(payload), createdAt) as { sequence: number };
    return row.sequence;
  }

  /**
   * Read events from an exclusive sequence offset, ordered by sequence.
   * Used by rebuildProjections() to replay the log after a restart.
   */
  readFromSequence(sequenceExclusive: number, limit = 1000): EventRow[] {
    return (this.db
      .prepare("SELECT sequence, event_type, stream_id, payload_json, created_at FROM orchestration_events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?")
      .all(sequenceExclusive, limit) as Array<{
      sequence: number;
      event_type: string;
      stream_id: string;
      payload_json: string;
      created_at: number;
    }>).map((r) => ({
      sequence: r.sequence,
      eventType: r.event_type,
      streamId: r.stream_id,
      payload: JSON.parse(r.payload_json),
      createdAt: r.created_at,
    }));
  }

  // ── Projections (apply) ──────────────────────────────────────────

  /**
   * Apply one event to the projections. Mirrors t3code's projectEvent +
   * the delta-concatenation rule: streaming deltas APPEND, final events REPLACE.
   * Returns true if a projection changed (used by write/rebuild to checkpoint).
   * Internal — called by write() and rebuildProjections().
   */
  applyEvent(ev: EventRow): boolean {
    const p = ev.payload;
    switch (ev.eventType) {
      case "project.created": {
        const pr = p.project as Project;
        this.upsertProject(pr);
        return true;
      }
      case "project.state": {
        this.db
          .prepare("UPDATE projection_projects SET state = ?, updated_at = ? WHERE id = ?")
          .run(p.state as State, Date.now(), p.projectId as string);
        return true;
      }
      case "session.created": {
        const s = p.session as Session;
        this.upsertSession(s);
        return true;
      }
      case "session.state": {
        this.db.prepare("UPDATE projection_sessions SET state = ? WHERE key = ?").run(p.state as State, p.sessionKey as string);
        return true;
      }
      case "session.noInbox": {
        this.db.prepare("UPDATE projection_sessions SET no_inbox = ? WHERE key = ?").run(p.noInbox ? 1 : 0, p.sessionKey as string);
        return true;
      }
      case "session.model": {
        this.db.prepare("UPDATE projection_sessions SET model_id = ? WHERE key = ?").run(p.modelId as string, p.sessionKey as string);
        return true;
      }
      case "session.thinking": {
        this.db.prepare("UPDATE projection_sessions SET thinking_level = ? WHERE key = ?").run(p.level as string, p.sessionKey as string);
        return true;
      }
      case "session.touched": {
        this.db.prepare("UPDATE projection_sessions SET last_touched_at = ? WHERE key = ?").run(ev.createdAt, p.sessionKey as string);
        return true;
      }
      case "message.sent": {
        const streaming = p.streaming === true;
        const nextIndex = this.nextMessageIndex(p.sessionKey as string);
        // t3code rule: append for streaming, replace for final
        const existing = this.db
          .prepare("SELECT text FROM projection_messages WHERE id = ?")
          .get(p.messageId as string) as { text: string } | undefined;
        const nextText = existing
          ? streaming
            ? existing.text + (p.text as string)
            : (p.text as string)
          : (p.text as string);
        this.db
          .prepare(
            `INSERT INTO projection_messages (id, session_key, role, text, is_streaming, timestamp, idx)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               text = excluded.text,
               is_streaming = excluded.is_streaming,
               timestamp = excluded.timestamp`,
          )
          .run(
            p.messageId as string,
            p.sessionKey as string,
            p.role as string,
            nextText,
            streaming ? 1 : 0,
            ev.createdAt,
            nextIndex,
          );
        // touch the session so inbox recency reflects activity
        this.db.prepare("UPDATE projection_sessions SET last_touched_at = ? WHERE key = ?").run(ev.createdAt, p.sessionKey as string);
        return true;
      }
      default:
        return false;
    }
  }

  /** Compute the next message index for a session. Internal — used by applyEvent. */
  private nextMessageIndex(sessionKey: string): number {
    const row = this.db
      .prepare("SELECT MAX(idx) AS m FROM projection_messages WHERE session_key = ?")
      .get(sessionKey) as { m: number | null };
    return (row.m ?? -1) + 1;
  }

  // ── Checkpoint + rebuild (t3code ProjectionPipeline.bootstrap) ────

  /** Read the last-applied sequence for a projector. Internal. */
  private getCheckpoint(projector: string): number {
    const row = this.db.prepare("SELECT last_applied_sequence FROM projection_state WHERE projector = ?").get(projector) as
      | { last_applied_sequence: number }
      | undefined;
    return row?.last_applied_sequence ?? 0;
  }

  /** Record the last-applied sequence for a projector. Internal. */
  private checkpoint(projector: string, sequence: number) {
    this.db
      .prepare(
        `INSERT INTO projection_state (projector, last_applied_sequence)
         VALUES (?, ?)
         ON CONFLICT(projector) DO UPDATE SET last_applied_sequence = excluded.last_applied_sequence`,
      )
      .run(projector, sequence);
  }

  /**
   * Replay the log from each projector's last applied sequence (t3code bootstrap).
   * Called by index.ts at startup so the read models are current after a restart.
   */
  rebuildProjections() {
    const projector = "default";
    const from = this.getCheckpoint(projector);
    for (const ev of this.readFromSequence(from)) {
      if (this.applyEvent(ev)) this.checkpoint(projector, ev.sequence);
    }
  }

  // ── Write helper (append + project + checkpoint, the t3code transaction) ──

  /**
   * The core write path: append to log, apply projection, checkpoint.
   * In t3code these run inside one SQL transaction; node:sqlite is
   * synchronous so the ordering is inherently sequential. Returns the sequence.
   * Called by relay.ts (user prompt + assistant deltas) and by the routes
   * (project/session lifecycle writes).
   */
  write(ev: DomainEvent): number {
    const seq = this.appendEvent(ev.type, this.streamIdOf(ev), ev.payload);
    const row: EventRow = {
      sequence: seq,
      eventType: ev.type,
      streamId: this.streamIdOf(ev),
      payload: ev.payload,
      createdAt: Date.now(),
    };
    if (this.applyEvent(row)) this.checkpoint("default", seq);
    return seq;
  }

  /** Derive the streamId (sessionKey / session key / project id) for an event. Internal. */
  private streamIdOf(ev: DomainEvent): string {
    const p = ev.payload as Record<string, unknown>;
    return (
      (p.sessionKey as string) ??
      (p.session as Session)?.key ??
      (p.project as Project)?.id ??
      "main"
    );
  }

  // ── Upserts ──────────────────────────────────────────────────────

  /** Insert-or-update a project row. Internal — called by applyEvent. */
  private upsertProject(pr: Project) {
    this.db
      .prepare(
        `INSERT INTO projection_projects (id, name, emoji, dir, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, emoji = excluded.emoji, dir = excluded.dir,
           state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run(pr.id, pr.name, pr.emoji ?? null, pr.dir, pr.state, pr.createdAt, pr.updatedAt);
  }

  /** Insert-or-update a session row. Internal — called by applyEvent. */
  private upsertSession(s: Session) {
    this.db
      .prepare(
        `INSERT INTO projection_sessions (key, name, project_id, state, no_inbox, last_touched_at, model_id, thinking_level)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           name = excluded.name, project_id = excluded.project_id,
           state = excluded.state, no_inbox = excluded.no_inbox,
           model_id = excluded.model_id, thinking_level = excluded.thinking_level`,
      )
      .run(s.key, s.name, s.projectId, s.state, s.noInbox ? 1 : 0, s.lastTouchedAt ?? null, s.modelId ?? null, s.thinkingLevel ?? null);
  }

  // ── Read helpers ─────────────────────────────────────────────────

  /** All projects. Called by GET /api/projects (routes/projects.ts). */
  getProjects(): Project[] {
    // Map snake_case DB columns → the camelCase wire shape (Project).
    return (this.db.prepare("SELECT * FROM projection_projects ORDER BY created_at ASC").all() as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      emoji: (r.emoji as string | null) ?? undefined,
      dir: r.dir as string,
      state: r.state as State,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
    })) as Project[];
  }

  /**
   * A single conversation by key. build-gw6.5.1: used by piSession.open() to read
   * the stored modelId/thinkingLevel. Returns undefined when the key is unknown.
   */
  getSession(key: string): Session | undefined {
    const r = this.db.prepare("SELECT * FROM projection_sessions WHERE key = ?").get(key) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      key: r.key as string,
      name: r.name as string,
      projectId: r.project_id as string,
      state: r.state as State,
      noInbox: (r.no_inbox as number) === 1,
      lastTouchedAt: (r.last_touched_at as number | null) ?? null,
      modelId: (r.model_id as string | null) ?? null,
      thinkingLevel: (r.thinking_level as string | null) ?? null,
    } as Session;
  }

  /** A project's sessions. Called by GET /api/projects/:id/sessions. */
  getSessions(projectId: string): Session[] {
    // Map snake_case DB columns → the camelCase wire shape (Session).
    return (this.db
      .prepare("SELECT * FROM projection_sessions WHERE project_id = ? ORDER BY last_touched_at DESC")
      .all(projectId) as Array<Record<string, unknown>>).map((r) => ({
      key: r.key as string,
      name: r.name as string,
      projectId: r.project_id as string,
      state: r.state as State,
      noInbox: (r.no_inbox as number) === 1,
      lastTouchedAt: (r.last_touched_at as number | null) ?? null,
      modelId: (r.model_id as string | null) ?? null,
      thinkingLevel: (r.thinking_level as string | null) ?? null,
    })) as Session[];
  }

  /**
   * A conversation's messages (history, not live). Called by GET
   * /api/sessions/:key/messages and by piSession.open() to seed a resumed session.
   */
  getMessages(sessionKey: string): Message[] {
    // Map snake_case DB columns → the camelCase wire shape (Message).
    return (this.db
      .prepare("SELECT * FROM projection_messages WHERE session_key = ? ORDER BY idx ASC")
      .all(sessionKey) as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      sessionKey: r.session_key as string,
      role: r.role as "user" | "assistant",
      text: r.text as string,
      isStreaming: (r.is_streaming as number) === 1,
      timestamp: r.timestamp as number,
      idx: r.idx as number,
    })) as Message[];
  }

  /**
   * The inbox rail: active + not muted + touched within the window (default 48h).
   * Called by GET /api/inbox (routes/inbox.ts).
   */
  getInbox(now = Date.now(), windowMs = 48 * 60 * 60 * 1000): Session[] {
    // Map snake_case DB columns → the camelCase wire shape (Session).
    return (this.db
      .prepare(
        `SELECT s.* FROM projection_sessions s
         WHERE s.state = 'active' AND s.no_inbox = 0
           AND (s.last_touched_at IS NULL OR s.last_touched_at >= ?)
         ORDER BY COALESCE(s.last_touched_at, 0) DESC`,
      )
      .all(now - windowMs) as Array<Record<string, unknown>>).map((r) => ({
      key: r.key as string,
      name: r.name as string,
      projectId: r.project_id as string,
      state: r.state as State,
      noInbox: (r.no_inbox as number) === 1,
      lastTouchedAt: (r.last_touched_at as number | null) ?? null,
      modelId: (r.model_id as string | null) ?? null,
      thinkingLevel: (r.thinking_level as string | null) ?? null,
    })) as Session[];
  }
}
