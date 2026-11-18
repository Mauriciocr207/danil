import type { Msg } from "../chat/index.ts";

// Persisted transcript pieces use `${turn id}:${piece}`.
export function savedActivityTurn(message: Msg) {
  const separator = message.clave?.lastIndexOf(":") ?? -1;
  return separator > 0 ? message.clave!.slice(0, separator) : message.avanceDe || message.turno;
}

const acceptedInput = (message: Msg) => message.role === "user" && !message.permission && !message.respuestas && !message.shell;

/** Presentation position only: a captured input never grants ownership of saved responses. */
export class ActivityAnchor {
  private input: Msg | null;
  private observedInput = false;
  private outputObserved = false;
  constructor(snapshot: readonly Msg[] | null) {
    this.input = snapshot ? [...snapshot].reverse().find(acceptedInput) ?? null : null;
  }
  observe(message: Msg, previous?: Msg) {
    if (!acceptedInput(message)) { if (message.role !== "user") this.outputObserved = true; return; }
    if (this.input === previous || !this.outputObserved) {
      this.input = message;
      this.observedInput = true;
    }
  }
  reconcile(snapshot: readonly Msg[], prepend: boolean) {
    if (prepend || this.outputObserved || this.observedInput) return;
    const input = [...snapshot].reverse().find(acceptedInput);
    if (input) this.input = input;
  }
  inherit(other: ActivityAnchor) {
    if (this.input) return;
    this.input = other.input;
    this.observedInput = other.observedInput;
    this.outputObserved ||= other.outputObserved;
  }
  before(visible: readonly Msg[]): Msg | undefined {
    const input = this.input;
    if (!input) return;
    const position = visible.findIndex(message => acceptedInput(message) && (message === input ||
      Boolean(input.clave && message.clave === input.clave) || Boolean(input.turno && message.turno === input.turno)));
    return position >= 0 ? visible[position + 1] : undefined;
  }
}
