import type { SessionHandle } from "./piSession.ts";

export interface Turn {
  handle?: SessionHandle;
  abortRequested: boolean;
}

/** Shared by all viewers; browser connections never own turns. */
export class TurnRegistry {
  private turns = new Map<string, Turn>();
  has(key: string): boolean { return this.turns.has(key); }
  get(key: string): Turn | undefined { return this.turns.get(key); }
  start(key: string): Turn | undefined {
    if (this.has(key)) return undefined;
    const turn: Turn = { abortRequested: false };
    this.turns.set(key, turn);
    return turn;
  }
  delete(key: string): void { this.turns.delete(key); }
}
