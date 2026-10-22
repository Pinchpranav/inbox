// answers the question - what project can the user access?

import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { identity, type Identity } from "./auth.ts";
import type { StateStore, DomainEvent, Session } from "./stateStore.ts";

/** One permission rule for REST routes and live subscriptions. */
export class Access {
  constructor(private store: StateStore) {}
  canProject(user: Identity, projectId: string): boolean {
    return user.expiresAt > Date.now() && !!this.store.getProject(projectId) &&
      (user.isOwner || this.store.hasProjectAccess(projectId, user.email));
  }
  owner(c: Context): void {
    if (identity(c).expiresAt <= Date.now()) throw new HTTPException(401, { message: "authentication required" });
    if (!identity(c).isOwner) throw new HTTPException(403, { message: "owner only" });
  }
  project(c: Context, projectId: string): void {
    if (!this.canProject(identity(c), projectId)) throw new HTTPException(404, { message: "not found" });
  }
  session(c: Context, key: string): Session {
    const session = this.store.getSession(key);
    if (!session) throw new HTTPException(404, { message: "not found" });
    this.project(c, session.projectId);
    return session;
  }
  middleware: MiddlewareHandler = async (c, next) => {
    const parts = c.req.path.split("/").map(decodeURIComponent);
    if (parts[2] === "projects" && parts[3]) this.project(c, parts[3]);
    if (parts[2] === "sessions" && parts[3] && parts[3] !== "zdr") this.session(c, parts[3]);
    if (parts[2] === "chat" && parts[3]) this.session(c, parts[3]);
    await next();
  };
  /** Recheck after body reads; a grant may have been revoked meanwhile. */
  write(c: Context, event: DomainEvent): number {
    if (event.type === "project.created") this.owner(c);
    else {
      if (event.type === "project.access.granted" || event.type === "project.access.revoked") this.owner(c);
      if ("projectId" in event.payload) this.project(c, event.payload.projectId);
      else if ("sessionKey" in event.payload) this.session(c, event.payload.sessionKey);
      else if (event.type === "session.created") this.project(c, event.payload.session.projectId);
    }
    return this.store.write(event);
  }
}
