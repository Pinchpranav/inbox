// stateStore.ts — the only file that touches the database. Every fact is
// appended to an event log first (the durable truth); the tables the app reads
// are that log applied in order, so they can be rebuilt at any time. write()
// is the one way in, and node:sqlite is synchronous, so a fact is on disk
// before write() returns.
//
// Used by:
//   index.ts   open, rebuildProjections(), close()
//   relay.ts   write() for prompts and assistant text
//   routes/*   write() and the read helpers
//   piSession  getSession() / getMessages() for the model and history seed

import { DatabaseSync } from "node:sqlite";

// ── Domain types ────────────────────────────────────────────────────
// The shapes the app passes around; snake_case column names never leave this file.

export type State = "active" | "deferred" | "done";

/** A project: one working directory plus the agent that runs inside it. */
export interface Project {
  id: string;
  name: string;
  emoji?: string;
  dir: string;
  state: State;
  createdAt: number;
  updatedAt: number;
}

/** A conversation (one thread) inside a project, addressed by its key. */
export interface Session {
  key: string; // "agent:<projectId>:<thread>"
  name: string;
  projectId: string;
  state: State;
  noInbox: boolean; // muted: hides it from the inbox rail
  lastTouchedAt: number | null; // null → never touched
  /** Stored model slug (e.g. "deepseek/deepseek-v4.1-flash"). null → manager default. */
  modelId?: string | null;
  /** Stored thinking level (off|minimal|low|medium|high|xhigh|max). null → "off". */
  thinkingLevel?: string | null;
}

export interface Message {
  id: string;
  sessionKey: string;
  role: "user" | "assistant";
  text: string;
  isStreaming: boolean; // true while the assistant is still writing this text
  timestamp: number;
  idx: number; // position in the conversation — history is read in idx order
  authorEmail?: string | null; // who sent it; null for assistant output
}

export interface EventRow {
  sequence: number; // global order, assigned by SQLite
  eventType: string;
  streamId: string; // the project or conversation it belongs to
  payload: Record<string, unknown>;
  createdAt: number;
}

// ── Event types ─────────────────────────────────────────────────────

/** Every fact write() accepts. Adding one: a line here + a case in applyEvent(). */
export type DomainEvent =
  | { type: "project.created"; payload: { project: Project } }
  | { type: "project.state"; payload: { projectId: string; state: State } }
  | { type: "project.renamed"; payload: { projectId: string; name: string } }
  | { type: "project.deleted"; payload: { projectId: string } }
  | { type: "project.access.granted" | "project.access.revoked"; payload: { projectId: string; email: string } }
  | { type: "session.created"; payload: { session: Session } }
  | { type: "session.state"; payload: { sessionKey: string; state: State } }
  | { type: "session.noInbox"; payload: { sessionKey: string; noInbox: boolean } }
  | { type: "session.model"; payload: { sessionKey: string; modelId: string } }
  | { type: "session.thinking"; payload: { sessionKey: string; level: string } }
  | { type: "session.touched"; payload: { sessionKey: string } }
  | { type: "session.renamed"; payload: { sessionKey: string; name: string } }
  | { type: "session.deleted"; payload: { sessionKey: string } }
  // a message was written: the user's prompt, or one chunk of the answer
  | { type: "message.sent"; payload: { messageId: string; role: "user" | "assistant"; text: string; streaming?: boolean; sessionKey: string; authorEmail?: string } };

// ── Store ───────────────────────────────────────────────────────────

/** One instance per process. Owns the only DB connection. */
export class StateStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.migrate();
  }

  close() {
    this.db.close();
  }

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
      CREATE TABLE IF NOT EXISTS projection_project_access (
        project_id TEXT NOT NULL,
        email TEXT NOT NULL,
        PRIMARY KEY (project_id, email)
      );
    `);

    // SQLite has no ADD COLUMN IF NOT EXISTS; adding an existing column is an error.
    const existingCols = new Set(
      (this.db.prepare("PRAGMA table_info(projection_sessions)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!existingCols.has("model_id")) {
      this.db.exec("ALTER TABLE projection_sessions ADD COLUMN model_id TEXT");
    }
    if (!existingCols.has("thinking_level")) {
      this.db.exec("ALTER TABLE projection_sessions ADD COLUMN thinking_level TEXT");
    }
    // Added later: per-table soft delete and the message author.
    for (const table of ["projection_projects", "projection_sessions", "projection_messages"]) {
      const cols = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
      const column = table === "projection_messages" ? "author_email TEXT" : "deleted INTEGER NOT NULL DEFAULT 0";
      if (!cols.has(column.split(" ")[0]!)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
    }
  }

  // ── Log (append) ─────────────────────────────────────────────────

  /** Insert one log row and return its sequence; the payload is stringified JSON
   *  text in payload_json and parsed back out on read. Use write(), not this. */
  appendEvent(eventType: string, streamId: string, payload: Record<string, unknown>, createdAt = Date.now()): number {
    const row = this.db
      .prepare(
        "INSERT INTO orchestration_events (event_type, stream_id, payload_json, created_at) VALUES (?, ?, ?, ?) RETURNING sequence",
      )
      .get(eventType, streamId, JSON.stringify(payload), createdAt) as { sequence: number };
    return row.sequence;
  }

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
   * Fold one log row into the tables, one case per event type. Throws rather
   * than checkpoint an unapplied fact — log and tables would disagree forever.
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
          .run(p.state as State, ev.createdAt, p.projectId as string);
        return true;
      }
      case "project.renamed": {
        this.db.prepare("UPDATE projection_projects SET name = ?, updated_at = ? WHERE id = ?").run(p.name as string, ev.createdAt, p.projectId as string);
        return true;
      }
      case "project.deleted": {
        // Soft delete: hide the project, its conversations and its access list.
        this.db.prepare("UPDATE projection_projects SET deleted = 1 WHERE id = ?").run(p.projectId as string);
        this.db.prepare("UPDATE projection_sessions SET deleted = 1 WHERE project_id = ?").run(p.projectId as string);
        this.db.prepare("DELETE FROM projection_project_access WHERE project_id = ?").run(p.projectId as string);
        return true;
      }
      case "project.access.granted": {
        this.db.prepare("INSERT OR IGNORE INTO projection_project_access (project_id, email) VALUES (?, ?)").run(p.projectId as string, p.email as string);
        return true;
      }
      case "project.access.revoked": {
        this.db.prepare("DELETE FROM projection_project_access WHERE project_id = ? AND email = ?").run(p.projectId as string, p.email as string);
        return true;
      }
      case "session.renamed": {
        this.db.prepare("UPDATE projection_sessions SET name = ? WHERE key = ?").run(p.name as string, p.sessionKey as string);
        return true;
      }
      case "session.deleted": {
        this.db.prepare("UPDATE projection_sessions SET deleted = 1 WHERE key = ?").run(p.sessionKey as string);
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
        // Recency bump — this orders the inbox rail.
        this.db.prepare("UPDATE projection_sessions SET last_touched_at = ? WHERE key = ?").run(ev.createdAt, p.sessionKey as string);
        return true;
      }
      case "message.sent": {
        const streaming = p.streaming === true;
        const nextIndex = this.nextMessageIndex(p.sessionKey as string);
        // A streaming chunk appends; the final text for the same id replaces it.
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
            `INSERT INTO projection_messages (id, session_key, role, text, is_streaming, timestamp, idx, author_email)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
            (p.authorEmail as string | undefined) ?? null,
          );
        // A new message counts as activity for the inbox.
        this.db.prepare("UPDATE projection_sessions SET last_touched_at = ? WHERE key = ?").run(ev.createdAt, p.sessionKey as string);
        return true;
      }
      default:
        throw new Error(`unknown event type "${ev.eventType}" at sequence ${ev.sequence}`);
    }
  }

  private nextMessageIndex(sessionKey: string): number {
    const row = this.db
      .prepare("SELECT MAX(idx) AS m FROM projection_messages WHERE session_key = ?")
      .get(sessionKey) as { m: number | null };
    return (row.m ?? -1) + 1;
  }

  // ── Checkpoint + rebuild ─────────────────────────────────────────

  /** How far the projections have been caught up with the log (0 = not at all). */
  private getCheckpoint(projector: string): number {
    const row = this.db.prepare("SELECT last_applied_sequence FROM projection_state WHERE projector = ?").get(projector) as
      | { last_applied_sequence: number }
      | undefined;
    return row?.last_applied_sequence ?? 0;
  }

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
   * Startup: replay log rows after the checkpoint, applying each with its
   * checkpoint in one transaction so a crash never applies a row twice.
   */
  rebuildProjections() {
    const projector = "default"; // one projector for the whole store
    let from = this.getCheckpoint(projector);
    for (;;) {
      const batch = this.readFromSequence(from);
      if (!batch.length) break;
      for (const ev of batch) {
        this.transaction(() => {
          this.applyEvent(ev);
          this.checkpoint(projector, ev.sequence);
        });
        from = ev.sequence;
      }
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ── Write helper ─────────────────────────────────────────────────

  /**
   * The only way to change state: append the fact, fold it into the tables and
   * move the checkpoint — all in one transaction, because a crash mid-step
   * would leave tables ahead of the checkpoint and the restart would replay
   * (and for a streaming chunk, double) the fact. Returns the fact's sequence.
   */
  write(ev: DomainEvent): number {
    return this.transaction(() => {
      const createdAt = Date.now();
      const seq = this.appendEvent(ev.type, this.streamIdOf(ev), ev.payload, createdAt);
      const row: EventRow = {
        sequence: seq,
        eventType: ev.type,
        streamId: this.streamIdOf(ev),
        payload: ev.payload,
        createdAt,
      };
      this.applyEvent(row);
      this.checkpoint("default", seq);
      return seq;
    });
  }

  private streamIdOf(ev: DomainEvent): string {
    const p = ev.payload as Record<string, unknown>;
    return (
      (p.sessionKey as string) ??
      (p.session as Session)?.key ??
      (p.project as Project)?.id ??
      (p.projectId as string) ??
      "main"
    );
  }

  // ── Upserts (written only by applyEvent) ─────────────────────────

  /** Insert, overwrite, or resurrect the whole project row. */
  private upsertProject(pr: Project) {
    this.db
      .prepare(
        `INSERT INTO projection_projects (id, name, emoji, dir, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, emoji = excluded.emoji, dir = excluded.dir,
           state = excluded.state, updated_at = excluded.updated_at,
           deleted = 0`,
      )
      .run(pr.id, pr.name, pr.emoji ?? null, pr.dir, pr.state, pr.createdAt, pr.updatedAt);
  }

  /** Insert, overwrite, or resurrect the whole session row. */
  private upsertSession(s: Session) {
    this.db
      .prepare(
        `INSERT INTO projection_sessions (key, name, project_id, state, no_inbox, last_touched_at, model_id, thinking_level)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           name = excluded.name, project_id = excluded.project_id,
           state = excluded.state, no_inbox = excluded.no_inbox,
           model_id = excluded.model_id, thinking_level = excluded.thinking_level,
           deleted = 0`,
      )
      .run(s.key, s.name, s.projectId, s.state, s.noInbox ? 1 : 0, s.lastTouchedAt ?? null, s.modelId ?? null, s.thinkingLevel ?? null);
  }

  // ── Read helpers (soft-deleted rows are filtered out) ────────────

  getProjects(): Project[] {
    return (this.db.prepare("SELECT * FROM projection_projects WHERE deleted = 0 ORDER BY created_at ASC").all() as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      emoji: (r.emoji as string | null) ?? undefined,
      dir: r.dir as string,
      state: r.state as State,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
    })) as Project[];
  }

  /** One conversation by key; undefined when it or its project is deleted. */
  getSession(key: string): Session | undefined {
    const r = this.db.prepare("SELECT s.* FROM projection_sessions s JOIN projection_projects p ON p.id = s.project_id WHERE s.key = ? AND s.deleted = 0 AND p.deleted = 0").get(key) as Record<string, unknown> | undefined;
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

  getSessions(projectId: string): Session[] {
    return (this.db
      .prepare("SELECT s.* FROM projection_sessions s JOIN projection_projects p ON p.id = s.project_id WHERE s.project_id = ? AND s.deleted = 0 AND p.deleted = 0 ORDER BY s.last_touched_at DESC")
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

  getMessages(sessionKey: string): Message[] {
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
      authorEmail: (r.author_email as string | null) ?? null,
    })) as Message[];
  }

  /**
   * The inbox rail: active, not-muted conversations touched within the window
   * (48h by default), newest first. Never-touched ones are always shown.
   */
  getInbox(now = Date.now(), windowMs = 48 * 60 * 60 * 1000): Session[] {
    return (this.db
      .prepare(
        `SELECT s.* FROM projection_sessions s JOIN projection_projects p ON p.id = s.project_id
         WHERE s.deleted = 0 AND p.deleted = 0 AND s.state = 'active' AND s.no_inbox = 0
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

  /** One project by id, or undefined. Access uses this to authorise a request. */
  getProject(id: string): Project | undefined {
    return this.getProjects().find((p) => p.id === id);
  }

  /** Emails explicitly granted access to a project. The owner is not listed. */
  getProjectUsers(projectId: string): string[] {
    return (this.db.prepare("SELECT email FROM projection_project_access WHERE project_id = ? ORDER BY email").all(projectId) as Array<{ email: string }>).map((r) => r.email);
  }

  /** Was this email granted this project? (The owner bypasses this — see Access.) */
  hasProjectAccess(projectId: string, email: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM projection_project_access WHERE project_id = ? AND email = ?").get(projectId, email);
  }
}
