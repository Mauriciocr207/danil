import type { Msg } from "../chat/index.ts";

// Persisted transcript pieces use `${turn id}:${piece}`.
export function savedActivityTurn(message: Msg) {
  const separator = message.clave?.lastIndexOf(":") ?? -1;
  return separator > 0 ? message.clave!.slice(0, separator) : message.avanceDe || message.turno;
}

/** Presentation position only: a captured input never grants ownership of saved responses. */
export class ActivityAnchor {
  private input: Msg | null;
  private awaitingSnapshot: boolean;
  private outputObserved = false;
  constructor(snapshot: readonly Msg[] | null) {
    this.input = snapshot ? [...snapshot].reverse().find(message => message.role === "user") ?? null : null;
    this.awaitingSnapshot = snapshot === null;
  }
  observe(message: Msg, previous?: Msg) {
    if (message.role !== "user") { this.outputObserved = true; return; }
    if (this.input === previous || !this.outputObserved) {
      this.input = message;
      this.awaitingSnapshot = false;
    }
  }
  reconcile(snapshot: readonly Msg[]) {
    if (!this.awaitingSnapshot || snapshot.length === 0) return;
    this.input = [...snapshot].reverse().find(message => message.role === "user") ?? null;
    this.awaitingSnapshot = false;
  }
  inherit(other: ActivityAnchor) {
    if (this.input) return;
    this.input = other.input;
    this.awaitingSnapshot = other.awaitingSnapshot;
  }
  before(visible: readonly Msg[]): Msg | undefined {
    const input = this.input;
    if (!input) return;
    const position = visible.findIndex(message => message.role === "user" && (message === input ||
      Boolean(input.clave && message.clave === input.clave) || Boolean(input.turno && message.turno === input.turno)));
    return position >= 0 ? visible[position + 1] : undefined;
  }
}
