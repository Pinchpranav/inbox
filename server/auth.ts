// main crux -   return async (c, next) => {} in export function authenticate
//
// Two questions answered in this file:
//   1. origin   — did this come from our page? (cookies make "authenticated" ≠ "ours")
//   2. identity — which verified email is it?

import { createRemoteJWKSet, jwtVerify } from "jose";
import { HTTPException } from "hono/http-exception";
import type { Context, MiddlewareHandler } from "hono";

const DEFAULT_OWNER = "pranav0202@gmail.com";
const DAY_MS = 24 * 60 * 60 * 1000;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const IDENTITY_HEADER = "cf-access-jwt-assertion";

export interface Identity {
  email: string;
  isOwner: boolean;
  expiresAt: number;
}

export interface AuthOptions {
  ownerEmail?: string;
  teamDomain?: string;
  audience?: string;
  publicOrigin?: string;
  devEmail?: string;
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export const validEmail = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

export const identity = (c: Context): Identity => c.get("identity") as Identity;

/** Verified email + when it stops being valid; `isOwner` is attached by the caller. */
type Resolved = { email: string; expiresAt: number };

export function authenticate(options: AuthOptions): MiddlewareHandler {
  const owner = normalizeEmail(options.ownerEmail ?? DEFAULT_OWNER);
  const expectedHost = options.publicOrigin ? new URL(options.publicOrigin).host : undefined;

  const team = options.teamDomain?.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const issuer = team ? `https://${team}` : undefined;
  const keys = issuer ? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)) : undefined;

  // Dev identity is opt-in and impossible off-localhost and in production.
  const dev = options.devEmail ? normalizeEmail(options.devEmail) : undefined;
  if (dev && process.env.NODE_ENV === "production") throw new Error("INBOX_DEV_EMAIL is forbidden in production");
  if (dev && !validEmail(dev)) throw new Error("Invalid INBOX_DEV_EMAIL");

  async function cloudflare(c: Context): Promise<Resolved | null> {
    const token = c.req.header(IDENTITY_HEADER);
    if (!token || !keys || !issuer || !options.audience) return null;
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer, audience: options.audience, algorithms: ["RS256"], requiredClaims: ["exp", "email"],
      });
      return validEmail(payload.email) ? { email: normalizeEmail(payload.email), expiresAt: payload.exp! * 1000 } : null;
    } catch {
      return null;
    }
  }

  const local = (c: Context): Resolved | null =>
    dev && LOCAL_HOSTS.has(new URL(c.req.url).hostname) ? { email: dev, expiresAt: Date.now() + DAY_MS } : null;

  return async (c, next) => {
    rejectForeignOrigin(c, expectedHost);
    const who = dev ? local(c) : await cloudflare(c);
    if (!who) throw new HTTPException(401, { message: "authentication required" });
    c.set("identity", { ...who, isOwner: who.email === owner } satisfies Identity);
    c.header("Cache-Control", "no-store");
    await next();
  };
}

/**
 * Browsers expose the initiating page as Origin; a different host means the request
 * came from someone else's page. WebSockets have no same-origin policy and always
 * send Origin, so they are held to it too. GETs are exempt (no side effects).
 */
function rejectForeignOrigin(c: Context, expectedHost?: string): void {
  const upgrade = c.req.header("upgrade")?.toLowerCase() === "websocket";
  if (!upgrade && ["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return;

  const origin = c.req.header("origin");
  if (!origin) {
    if (upgrade) throw new HTTPException(403, { message: "origin required" });
    return; // non-browser client: no cookie to hijack, identity is still required
  }
  let host: string | null = null;
  try {
    host = new URL(origin).host;
  } catch {
    /* malformed Origin is foreign */
  }
  if (host !== (expectedHost ?? c.req.header("host"))) throw new HTTPException(403, { message: "origin not allowed" });
}
