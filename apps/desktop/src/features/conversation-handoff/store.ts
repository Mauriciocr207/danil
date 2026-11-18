import { batch, createSignal } from "solid-js";

export type ConversationScope = { workspace: string | null; generation: number; project: string; session: string; route?: { headers: Record<string, string> } };
export type HandoffView = { stopping: boolean; pending: { queueItemId: string; phase: "waiting-close" | "submitting" | "awaiting-start" } | null; error: unknown | null; released: boolean };
export type HandoffPresentation = { phase: "waiting-close"; pendingMessage: { text: string; attachments?: readonly string[] } }
  | { phase: "submitting" | "awaiting-start" } | null;
export type HandoffFact = { scope: ConversationScope } & ({ kind: "terminal" | "started" | "accepted" } | { kind: "dispatching"; itemIds: readonly string[] } | { kind: "rejected"; error: unknown } | { kind: "queue-removed"; queueItemId: string });
type Dependencies = {
  current: () => { workspace: string | null; generation: number };
  runtime: { active: (scope: ConversationScope) => boolean; stop: (scope: ConversationScope) => Promise<unknown> };
  queue: { message: (scope: ConversationScope, id: string) => { text: string; attachments?: readonly string[] } | undefined; select: (scope: ConversationScope, id: string) => boolean; release: (scope: ConversationScope, id: string) => void; failed: (scope: ConversationScope, id: string, error: unknown) => void };
};
const EMPTY: HandoffView = { stopping: false, pending: null, error: null, released: false };
type Operation = { scope: ConversationScope; view: HandoffView; promise?: Promise<void>; acknowledged: boolean; terminal: boolean };
/** Local interruption intent and queue references; execution remains with the runtime. */
export function createConversationHandoff(deps: Dependencies) {
  const entries = new Map<string, Operation>();
  const [revision, setRevision] = createSignal(0);
  let disposed = false;
  const key = (scope: ConversationScope) => JSON.stringify([scope.workspace, scope.generation, scope.project, scope.session]);
  const current = (scope: ConversationScope) => {
    const now = deps.current();
    return !disposed && now.workspace === scope.workspace && now.generation === scope.generation;
  };
  const publish = () => setRevision(value => value + 1);
  const captured = (scope: ConversationScope): ConversationScope => ({ ...scope,
    route: scope.route ? { headers: { ...scope.route.headers } } : undefined });
  const operation = (scope: ConversationScope) => {
    const previous = entries.get(key(scope));
    if (previous) return previous;
    const created: Operation = { scope: captured(scope), view: { ...EMPTY }, acknowledged: false, terminal: false };
    entries.set(key(scope), created); return created;
  };
  const live = (entry: Operation) => current(entry.scope) && entries.get(key(entry.scope)) === entry;
  function release(entry: Operation) {
    if (!entry.acknowledged || !entry.terminal || entry.view.error !== null || entry.view.released) return;
    const pending = entry.view.pending;
    entry.view = { ...entry.view, stopping: false, released: true }; publish();
    if (pending) deps.queue.release(entry.scope, pending.queueItemId);
    else { entries.delete(key(entry.scope)); publish(); }
  }
  function observe(fact: HandoffFact) {
    if (!current(fact.scope)) return;
    const entry = entries.get(key(fact.scope));
    if (!entry) return;
    const pending = entry.view.pending;
    if (fact.kind === "terminal") {
      entry.terminal = true; release(entry);
    } else if (fact.kind === "dispatching" && pending && fact.itemIds.includes(pending.queueItemId) && entry.view.released) {
      entry.view = { ...entry.view, stopping: false, pending: { ...pending, phase: "submitting" } }; publish();
    } else if (fact.kind === "accepted" && pending?.phase === "submitting") {
      entry.view = { ...entry.view, pending: { ...pending, phase: "awaiting-start" }, error: null }; publish();
    } else if (fact.kind === "started" && pending && pending.phase !== "waiting-close") {
      entries.delete(key(entry.scope)); publish();
    } else if (fact.kind === "queue-removed" && pending?.queueItemId === fact.queueItemId) {
      entry.view = { ...entry.view, pending: null }; if (!entry.view.stopping) entries.delete(key(entry.scope)); publish();
    } else if (fact.kind === "rejected" && pending?.phase === "submitting" && entry.view.error === null) {
      entry.view = { ...entry.view, error: fact.error }; publish();
      deps.queue.failed(entry.scope, pending.queueItemId, fact.error);
    }
  }
  function requestStop(scope: ConversationScope): Promise<void> {
    if (!current(scope)) return Promise.resolve();
    const entry = operation(scope);
    if (entry.view.stopping && entry.promise) return entry.promise;
    if (!deps.runtime.active(entry.scope)) { entry.acknowledged = true; observe({ kind: "terminal", scope: entry.scope }); return Promise.resolve(); }
    entry.acknowledged = false; entry.terminal = false;
    entry.view = { ...entry.view, stopping: true, error: null }; publish();
    entry.promise = (async () => {
      try {
        const reply = await deps.runtime.stop(entry.scope);
        if (!live(entry)) return;
        if (reply === false) { entry.acknowledged = true; entry.view = { ...entry.view, stopping: false }; if (!entry.view.pending) entries.delete(key(entry.scope)); publish(); release(entry); return; }
        entry.acknowledged = true; release(entry);
      }
      catch (error) {
        if (!live(entry) || entry.view.released) return;
        entry.view = { ...entry.view, stopping: false, error }; publish();
        if (entry.view.pending) deps.queue.failed(entry.scope, entry.view.pending.queueItemId, error);
      }
    })();
    return entry.promise;
  }
  function replaceWithQueued(scope: ConversationScope, id: string): Promise<void> {
    if (!current(scope)) return Promise.resolve();
    const entry = operation(scope);
    if (entry.view.pending?.queueItemId === id && !entry.view.error) return entry.promise ?? Promise.resolve();
    if (entry.view.pending && entry.view.pending.phase !== "waiting-close") return entry.promise ?? Promise.resolve();
    const wasActive = deps.runtime.active(entry.scope);
    batch(() => {
      entry.view = { ...entry.view, pending: { queueItemId: id, phase: "waiting-close" }, error: null, released: false }; publish();
      if (!deps.queue.select(entry.scope, id)) { entries.delete(key(entry.scope)); publish(); }
      else if (!wasActive) { entry.acknowledged = true; observe({ kind: "terminal", scope: entry.scope }); }
    });
    return wasActive && entries.get(key(scope)) === entry ? requestStop(entry.scope) : Promise.resolve();
  }
  const view = (scope: ConversationScope): HandoffView => { revision(); return current(scope) ? entries.get(key(scope))?.view ?? EMPTY : EMPTY; };
  function presentation(scope: ConversationScope): HandoffPresentation {
    const pending = view(scope).pending;
    if (!pending) return null;
    if (pending.phase !== "waiting-close") return { phase: pending.phase };
    const message = deps.queue.message(scope, pending.queueItemId);
    return message ? { phase: "waiting-close", pendingMessage: message } : null;
  }
  return { requestStop, replaceWithQueued, observe, view, presentation,
    blocked: (scope: ConversationScope) => { const state = view(scope); return state.stopping || !!state.pending && !state.released; },
    reset: () => { entries.clear(); publish(); },
    dispose: () => { disposed = true; entries.clear(); publish(); } };
}
