// turnRegistry.ts — which conversations currently have a turn in flight.
//
// Process-wide source of truth for "is a turn running on sessionKey?" It
// replaces the old per-WS-connection `busy` flag: the WS route (chat.ts)
// WRITES to it around `await session.prompt()`, and the REST route
// (sessions.ts, GET /api/sessions/:key/status) READS from it — the two
// routers never talk to each other, they both touch this Set.
//
// Why it works: pi's session.prompt() is a promise that resolves only when
// the whole turn is done (tools, thinking, streamed text), so the promise's
// lifetime IS the turn's lifetime. add() before the await, delete() in
// `finally` (so errors and aborts pass through too).
//
// Guard duty: a second prompt for the same key while a turn is running is
// rejected (two prompt() calls on one AgentSession would interleave).

const runningTurns = new Set<string>();

export const turnRegistry = {
  has: (sessionKey: string): boolean => runningTurns.has(sessionKey),
  add: (sessionKey: string): void => void runningTurns.add(sessionKey),
  delete: (sessionKey: string): void => void runningTurns.delete(sessionKey),
  /** All currently-running keys (for the bulk view endpoint, later). */
  keys: (): string[] => [...runningTurns],
};
