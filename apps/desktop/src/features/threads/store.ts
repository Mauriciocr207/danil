import { createMemo, createSignal, untrack } from "solid-js";
import { anexarDeltas, hasOlder, hasRecentGap, HistoryPager, lotesDeDeltas, mensajesDelHilo, transcripcion, type ChatEvent, type HandoverState, type Msg, type OlderState, type Session, type TranscriptOrigin, type Turn } from "../chat/index.ts";
import { conservarEnOrden, conservarPorClave } from "../../lib/sessionRefresh.ts";
import { transcriptEvent, type TranscriptMetadata } from "./transcript-events.ts";

type Options = { headers: Record<string, string> };
type Invoke = <T>(command: string, args?: Record<string, unknown>, options?: Options) => Promise<T>;
/** Owns painted conversation state and history; lifecycle and sending consume semantic facts. */
export function createThreadsStore(deps: {
  scope: { workspace: () => string | null; generation: () => number; paged: () => boolean };
  activeSession: () => string | null;
  project: () => string;
  invoke: Invoke;
  route: (id: string) => Options | undefined;
  liveThreads: () => ReadonlySet<string>;
}) {
  const { invoke } = deps;
  let disposed = false;
  const route = (id: string) => {
    const options = deps.route(id), workspace = deps.scope.workspace();
    return { ...options, headers: { ...options?.headers, ...(workspace ? { "x-terminus-workspace": workspace } : {}) } };
  };
  type Optimistic = { original: Msg; row: Msg; acknowledged?: number };
  type Hilo = { base: Msg[]; vivo: Msg[]; guardados?: ReadonlySet<string>; optimistic?: Optimistic[]; readRevision?: number };
  let revision = 0;
  const reads = new WeakMap<Session, { id: string; generation: number; revision: number }>();
  const SIN_HILO: Hilo = { base: [], vivo: [] };
  const workspaceThreads = new Map<string, Record<string, Hilo>>();
  const [hilos, setHilos] = createSignal<Record<string, Hilo>>({});
  const hiloAbierto = createMemo(() => hilos()[(deps.activeSession() ?? "")]);
  const msgs = createMemo<Msg[]>(() => {
    const h = hiloAbierto();
    return h ? mensajesDelHilo(h) : [];
  });
  const [cargandoHilo, setCargandoHilo] = createSignal<string | null>(null);
  const escribirVivo = (session: string, fn: (vivo: Msg[]) => Msg[], workspace = deps.scope.workspace()) => {
    if (disposed) return;
    if (workspace && workspace !== deps.scope.workspace()) {
      const threads = workspaceThreads.get(workspace) ?? {};
      const thread = threads[session] ?? SIN_HILO;
      workspaceThreads.set(workspace, { ...threads, [session]: { ...thread, vivo: fn(thread.vivo) } });
      return;
    }
    setHilos((hs) => {
      const h = hs[session] ?? SIN_HILO;
      return { ...hs, [session]: { ...h, vivo: fn(h.vivo) } };
    });
  };
  const deltasPorCuadro = lotesDeDeltas((session, workspace, deltas) =>
    escribirVivo(session, (m) => anexarDeltas(m, deltas), workspace),
  );
  const anexar = (session: string, fn: (vivo: Msg[]) => Msg[], workspace = deps.scope.workspace()) => {
    if (disposed) return;
    deltasPorCuadro.vaciar();
    escribirVivo(session, fn, workspace);
  };
  const asentar = (session: string, fn: (base: Msg[]) => Msg[]) => {
    if (disposed) return;
    deltasPorCuadro.vaciar();
    setHilos((hs) => {
      const h = hs[session] ?? SIN_HILO;
      return { ...hs, [session]: { ...h, base: fn(h.base) } };
    });
  };
  type IdsDeTurnos = ReadonlySet<string>;
  const releer = (session: string, leida: Msg[], vaciarVivo: boolean, antepuesta = false, guardados?: IdsDeTurnos, cola?: IdsDeTurnos, readRevision?: number) => {
    if (disposed) return;
    deltasPorCuadro.vaciar();
    setHilos((hs) => {
      const previo = hs[session];
      const vivoPrevio = previo?.vivo ?? [];
      const ataduras = new Map(
        [...(previo?.base ?? []), ...vivoPrevio]
          .filter((m) => m.turno && m.questionRequestId)
          .map((m) => [m.turno as string, m.questionRequestId]),
      );
      const persistidos = new Set([
        ...leida.map((m) => m.turno).filter((t): t is string => !!t),
        ...(cola ?? []),
      ]);
      const atada =
        ataduras.size === 0
          ? leida
          : leida.map((m) =>
              m.turno && ataduras.has(m.turno)
                ? { ...m, questionRequestId: ataduras.get(m.turno) }
                : m,
            );
      // Una lectura anterior al ack no puede saber que el envío ya quedó en disco.
      // La identidad durable confirma una fila; el texto nunca identifica un envío.
      const optimistic = (previo?.optimistic ?? []).filter(entry =>
        !(entry.row.turno && persistidos.has(entry.row.turno)) &&
        !(entry.acknowledged !== undefined && readRevision !== undefined && readRevision > entry.acknowledged));
      const previousBase = previo?.optimistic?.length
        ? (previo.base).filter(row => !previo.optimistic?.some(entry => entry.row === row)) : previo?.base ?? [];
      const persisted = (antepuesta ? conservarPorClave : conservarEnOrden)(previousBase, atada);
      const base = optimistic.length ? [...persisted, ...optimistic.map(entry => entry.row)] : persisted;
      const vivo = vaciarVivo
        ? []
        : vivoPrevio.filter((m) => !m.turno || !persistidos.has(m.turno));
      const mismoVivo = vivo.length === vivoPrevio.length;
      const tramos = guardados ?? previo?.guardados;
      if (previo && base === previo.base && mismoVivo && tramos === previo.guardados && optimistic.length === (previo.optimistic?.length ?? 0) && readRevision === undefined) return hs;
      return { ...hs, [session]: { base, vivo: mismoVivo ? vivoPrevio : vivo, guardados: tramos, optimistic, readRevision: readRevision ?? previo?.readRevision } };
    });
  };
  const idsDeTurnos = (turns: readonly Turn[]) => new Set(turns.flatMap((t) => (t.id ? [t.id] : [])));
  const [origenes, setOrigenes] = createSignal<Readonly<Record<string, TranscriptOrigin | null>>>({});
  const [apagadas, setApagadas] = createSignal<Readonly<Record<string, string>>>({});
  const [encendiendo, setEncendiendo] = createSignal<Readonly<Record<string, string>>>({});
  const [traspasos, setTraspasos] = createSignal<Readonly<Record<string, HandoverState>>>({});
  const anotar = (set: typeof setApagadas, id: string, machine: string | null) =>
    set((all) => {
      if ((all[id] ?? null) === machine) return all;
      const { [id]: _, ...resto } = all;
      return machine ? { ...resto, [id]: machine } : resto;
    });
  const historias = new Map<string, HistoryPager<Session["turns"][number]>>();
  const proyectosDeHistoria = new Map<string, string>();
  const leyendoLejos = new Set<string>();
  const [conAntiguos, setConAntiguos] = createSignal<Readonly<Record<string, boolean>>>({});
  const [conRecientes, setConRecientes] = createSignal<Readonly<Record<string, boolean>>>({});
  const [estadoAntiguos, setEstadoAntiguos] = createSignal<Readonly<Record<string, OlderState>>>({});
  const marcarAntiguos = (id: string, pager: HistoryPager<unknown>) => {
    const loaded = pager.loaded;
    if (loaded) {
      setConAntiguos((all) => (!!all[id] === hasOlder(loaded) ? all : { ...all, [id]: hasOlder(loaded) }));
      const recent = hasRecentGap(loaded);
      setConRecientes(all => !!all[id] === recent ? all : { ...all, [id]: recent });
    }
    setEstadoAntiguos(all => (all[id] ?? "idle") === pager.older ? all : { ...all, [id]: pager.older });
  };
  const [colaSuelta, setColaSuelta] = createSignal<Readonly<Record<string, Msg[]>>>({});
  const recoveries = new WeakMap<HistoryPager<Session["turns"][number]>, Session>();
  const historiaDe = (id: string) => {
    const hay = historias.get(id);
    if (hay) return hay;
    const pager: HistoryPager<Session["turns"][number]> = new HistoryPager({
      read: async (before) => {
        const result = await leerTarea(proyectosDeHistoria.get(id) ?? deps.project(), id, before);
        // A rewritten older page recovers at the tail; only the store may accept
        // that snapshot, with the same ACK/generation checks as any other read.
        if (before === null && !disposed && reads.get(result)?.generation === deps.scope.generation()) {
          recoveries.set(pager, result); pager.close();
        }
        return result;
      },
      onChange: () => marcarAntiguos(id, pager),
    });
    historias.set(id, pager);
    return pager;
  };
  const leerTarea = async (project: string, id: string, before: number | null = null) => {
    if (disposed) throw new DOMException("Conversation disposed", "AbortError");
    proyectosDeHistoria.set(id, project);
    const provenance = { id, generation: deps.scope.generation(), revision: ++revision };
    const options = route(id);
    const result = deps.scope.paged()
      ? await invoke<Session>("load_history", { project, id, before }, options)
      : await invoke<Session>("load_session", { project, id, history_request: { version: 1, before } }, options);
    reads.set(result, provenance);
    if (result.history?.version === 1) {
      result.turns = result.turns.map(turn => ({ ...turn,
        history_refs: turn.history_refs?.map(ref => ({ ...ref, project, session: id })),
      }));
    }
    return result;
  };
  async function cargarAntiguos(project: string, id: string): Promise<(() => void) | null> {
    const pager = historias.get(id);
    if (!pager) return null;
    proyectosDeHistoria.set(id, project);
    const generation = deps.scope.generation();
    const poner = await pager.fetchOlder();
    if (disposed || generation !== deps.scope.generation()) return null;
    const recovery = recoveries.get(pager);
    if (recovery) {
      recoveries.delete(pager);
      loadResult(id, recovery, false, generation, true);
      return null;
    }
    pintarHistoria(id, pager, false);
    if (!poner) return null;
    return () => {
      if (disposed || generation !== deps.scope.generation()) return;
      poner();
      pintarHistoria(id, pager, true);
    };
  }
  function pintarHistoria(id: string, pager: HistoryPager<Session["turns"][number]>, antepuesta: boolean, clear = false, leidos?: ReadonlySet<string>, readRevision?: number) {
    const loaded = pager.loaded;
    if (!loaded) return;
    const leida = transcripcion(loaded.turns, loaded.start);
    if (hasRecentGap(loaded)) leida.push({ role: "system", text: "", meta: "history_gap", clave: "history_gap" });
    releer(id, leida, clear, antepuesta, idsDeTurnos(loaded.turns), leidos, hasRecentGap(loaded) ? undefined : readRevision);
  }
  function loadResult(id: string, session: Session, clear: boolean, generation: number, latest = false) {
    if (disposed || generation !== deps.scope.generation()) return false;
    const read = reads.get(session);
    if (read && (read.id !== id || read.generation !== deps.scope.generation() || read.revision < (untrack(hilos)[id]?.readRevision ?? 0))) return false;
    // Without durable IDs in the send ACK, only a read begun after every pending
    // send settled can safely replace optimistic rows with persisted history.
    const pending = untrack(hilos)[id]?.optimistic ?? [];
    if (pending.some(entry => entry.acknowledged === undefined || !read || read.revision <= entry.acknowledged)) return false;
    anotar(setApagadas, id, session.offline?.machine ?? null);
    setTraspasos((all) => {
      const previo = all[id];
      const ahora = {
        can: session.can_hand_over === true,
        blocked: session.hand_over_blocked ?? null,
        provider: session.provider ?? null,
        model: session.model ?? null,
        effort: session.effort ?? null,
      };
      if (
        previo &&
        previo.can === ahora.can &&
        previo.blocked === ahora.blocked &&
        previo.provider === ahora.provider &&
        previo.model === ahora.model &&
        previo.effort === ahora.effort
      ) return all;
      return { ...all, [id]: ahora };
    });
    const pager = historiaDe(id);
    if (latest) { pager.close(); pager.loaded = undefined; }
    const loaded = pager.accept(session.turns, session.history, { reading: leyendoLejos.has(id) });
    setColaSuelta((all) => {
      if (hasRecentGap(loaded)) return { ...all, [id]: transcripcion(session.turns, session.history?.start ?? 0) };
      if (!(id in all)) return all;
      const { [id]: _, ...resto } = all;
      return resto;
    });
    pintarHistoria(id, pager, false, clear, idsDeTurnos(session.turns), read?.revision);
    if (read) setHilos(all => ({ ...all, [id]: { ...all[id], readRevision: read.revision } }));
    const origen = session.transcript ?? null;
    setOrigenes((o) =>
      id in o && o[id]?.file === origen?.file && o[id]?.from_cli === origen?.from_cli ? o : { ...o, [id]: origen },
    );
    return true;
  }
  const soltarHilo = (session: string) => {
    deltasPorCuadro.vaciar();
    setHilos((hs) => {
      historias.get(session)?.close();
      historias.delete(session);
      if (!(session in hs)) return hs;
      const { [session]: _, ...resto } = hs;
      return resto;
    });
  };
  function appendLive(session: string, messages: Msg[], workspace = deps.scope.workspace()) {
    if (disposed || messages.length === 0) return;
    anexar(session, before => [...before, ...messages], workspace);
  }
  function appendPersisted(session: string, messages: Msg[]) {
    if (!disposed && messages.length) asentar(session, before => [...before, ...messages]);
  }
  function appendOptimistic(session: string, messages: Msg[]) {
    if (disposed || !messages.length) return;
    appendPersisted(session, messages);
    setHilos(all => ({ ...all, [session]: { ...all[session], optimistic: [
      ...(all[session].optimistic ?? []), ...messages.map(row => ({ original: row, row })),
    ] } }));
  }
  function acknowledgeOptimistic(session: string, messages: Msg[]) {
    if (disposed) return;
    const acknowledged = ++revision;
    const acknowledge = (all: Record<string, Hilo>) => {
      const thread = all[session];
      if (!thread?.optimistic?.some(entry => messages.includes(entry.original))) return all;
      return { ...all, [session]: { ...thread, optimistic: thread.optimistic.map(entry =>
        messages.includes(entry.original) ? { ...entry, acknowledged } : entry) } };
    };
    setHilos(acknowledge);
    for (const [workspace, threads] of workspaceThreads) workspaceThreads.set(workspace, acknowledge(threads));
  }

  function commitUniqueTurn(session: string, message: Msg) {
    if (!disposed) asentar(session, before => before.some(row => row.turno === message.turno) ? before : [...before, message]);
  }
  function replaceTurn(session: string, message: Msg) {
    if (!disposed) asentar(session, before => [...before.filter(row => !message.turno || row.turno !== message.turno), message]);
  }
  function reviseOptimistic(session: string, target: Msg, patch: Pick<Msg, "respuestas" | "author">) {
    if (disposed) return;
    const entry = untrack(hilos)[session]?.optimistic?.find(row => row.original === target);
    const previous = entry?.row ?? target, next = { ...previous, ...patch };
    if (entry) entry.row = next;
    if (!disposed) asentar(session, before => before.map(row => row === previous ? next : row));
  }
  function rejectOptimistic(session: string, messages: Msg[]) {
    if (disposed) return;
    const reject = (all: Record<string, Hilo>) => {
      const thread = all[session];
      if (!thread) return all;
      const rejected = thread.optimistic?.filter(entry => messages.includes(entry.original)) ?? [];
      const base = thread.base.filter(row => !messages.includes(row) && !rejected.some(entry => entry.row === row));
      if (base.length === thread.base.length && !rejected.length) return all;
      return { ...all, [session]: { ...thread, base, optimistic: thread.optimistic?.filter(entry => !rejected.includes(entry)) } };
    };
    setHilos(reject);
    for (const [workspace, threads] of workspaceThreads) workspaceThreads.set(workspace, reject(threads));
  }

  function question(session: string, fields: Pick<Msg, "turno" | "preguntas" | "questionRequestId" | "agent">, workspace = deps.scope.workspace()) {
    if (disposed) return;
    anexar(session, before => {
      const last = before.at(-1);
      return last?.role === "agent" && !last.turno
        ? [...before.slice(0, -1), { ...last, ...fields }]
        : [...before, { role: "agent", text: "", ...fields }];
    }, workspace);
  }
  function replay(session: string, workspace = deps.scope.workspace()) {
    if (!disposed) anexar(session, before => {
      const kept = before.filter(row => row.role === "user");
      return kept.length === before.length ? before : kept;
    }, workspace);
  }
  function finishSteps(session: string) {
    if (!disposed) anexar(session, before => before.some(row => row.paso?.corriendo)
      ? before.map(row => row.paso?.corriendo ? { ...row, paso: { ...row.paso, corriendo: false } } : row) : before);
  }
  function event(payload: ChatEvent, metadata: TranscriptMetadata) {
    if (disposed || !["delta", "reasoning", "image", "tool", "tool_done", "notice", "task_launched", "segment_saved", "command_output", "command_running"].includes(payload.kind)) return;
    if (payload.kind === "task_launched" && (!payload.task || !payload.id)) return;
    if (payload.kind === "segment_saved" && !payload.id) return;
    if (payload.kind === "image" && (payload.detail?.kind !== "output" || !payload.detail.images?.length)) return;
    const workspace = payload.workspace ?? deps.scope.workspace();
    if (payload.kind === "delta") {
      deltasPorCuadro.meter(payload.session, workspace ?? undefined, { text: payload.text, messageId: payload.message_id,
        startsMessage: payload.starts_message, author: metadata.author, model: metadata.model });
    } else anexar(payload.session, before => transcriptEvent(before, payload, metadata), workspace);
  }
  function saveWorkspace(previous: string | null) {
    deltasPorCuadro.vaciar();
    for (const pager of historias.values()) pager.close();
    if (previous) workspaceThreads.set(previous, Object.fromEntries(Object.entries(untrack(hilos)).filter(([id]) => deps.liveThreads().has(`${previous}/${id}`))));
  }
  function activateWorkspace(workspace: string | null) { if (!disposed) setHilos(workspace ? workspaceThreads.get(workspace) ?? {} : {}); }
  function resetService() {
    deltasPorCuadro.vaciar(); workspaceThreads.clear();
    setHilos(before => Object.fromEntries(Object.entries(before).map(([id, thread]) => [id, { ...thread, vivo: [] }])));
  }
  function adoptDraft(id: string) {
    deltasPorCuadro.vaciar();
    setHilos(before => {
      const { [""]: draft, ...rest } = before, previous = before[id] ?? SIN_HILO;
      return { ...rest, [id]: { base: [...(draft?.base ?? []), ...previous.base], vivo: [...(draft?.vivo ?? []), ...previous.vivo], guardados: previous.guardados, optimistic: [...(draft?.optimistic ?? []), ...(previous.optimistic ?? [])], readRevision: previous.readRevision } };
    });
  }
  async function latest(id: string) {
    const pager = historias.get(id), generation = deps.scope.generation();
    if (!pager || disposed) return;
    const result = await leerTarea(proyectosDeHistoria.get(id) ?? deps.project(), id);
    loadResult(id, result, false, generation, true);
  }
  function dropSaved(workspace: string, id: string) {
    const saved = workspaceThreads.get(workspace);
    if (!saved || !(id in saved)) return;
    const { [id]: _, ...rest } = saved; workspaceThreads.set(workspace, rest);
  }
  return {
    rows: hilos, current: hiloAbierto, messages: msgs, loading: cargandoHilo, origins: origenes, offline: apagadas, waking: encendiendo, handovers: traspasos,
    olderAvailable: conAntiguos, recentAvailable: conRecientes, olderStatus: estadoAntiguos, recentTail: colaSuelta,
    appendLive, appendPersisted, appendOptimistic, acknowledgeOptimistic, commitUniqueTurn, replaceTurn, reviseOptimistic, rejectOptimistic, question, replay, finishSteps, event,
    read: leerTarea, acceptSession: loadResult, older: cargarAntiguos, latest,
    replaceHistory: releer, saveWorkspace, activateWorkspace, resetService, adoptDraft, dropSaved,
    flush: deltasPorCuadro.vaciar,
    markWaking: (id: string, machine: string | null) => { if (!disposed) anotar(setEncendiendo, id, machine); },
    markAwake: (id: string) => { if (!disposed) anotar(setApagadas, id, null); },
    startLoading: (id: string) => { if (!disposed) setCargandoHilo(id); },
    finishLoading: (id: string) => { if (!disposed) setCargandoHilo(before => before === id ? null : before); },
    reading: (id: string, active: boolean) => { if (active) leyendoLejos.add(id); else leyendoLejos.delete(id); },
    drop: soltarHilo,
    dispose: () => { disposed = true; deltasPorCuadro.vaciar(); for (const pager of historias.values()) pager.close(); },
  };
}
