import type { Paso } from "../../lib/steps.ts";

type LiveMessage = { nativeMessageId?: string; turno?: string; duration_ms?: number; preguntas?: unknown[] };
export type ActivityChunk<M> = { pasos: Paso[]; msg: M; outside?: true };
export type ActivityBlock<M> =
  | { tipo: "msg"; msg: M; i: number }
  | { tipo: "pasos"; pasos: Paso[]; i: number; avance?: ActivityChunk<M>[] }
  | { tipo: "trabajo"; pasos: Paso[]; msg: M; i: number; avance?: ActivityChunk<M>[] };

/** Stream message IDs identify live progress; completed or unknown history stays separate. */
export function coalesceLiveActivity<M extends LiveMessage>(blocks: ActivityBlock<M>[], active: boolean): ActivityBlock<M>[] {
  if (!active) return blocks;
  const last = blocks.at(-1);
  const live = (message: M) => Boolean(message.nativeMessageId && (!message.turno || Boolean(message.preguntas?.length)) && message.duration_ms === undefined);
  if (!last || last.tipo === "msg" || (last.tipo === "trabajo" && !live(last.msg))) return blocks;
  let first = blocks.length - 1;
  const progress: ActivityChunk<M>[] = [];
  for (let previous = blocks[first - 1]; previous?.tipo === "trabajo" && live(previous.msg); previous = blocks[first - 1]) {
    progress.unshift(...(previous.avance ?? []), { pasos: previous.pasos, msg: previous.msg, outside: true });
    first--;
  }
  if (first === blocks.length - 1) return blocks;
  return [...blocks.slice(0, first), { ...last, i: blocks[first].i, avance: [...progress, ...(last.avance ?? [])] }];
}
