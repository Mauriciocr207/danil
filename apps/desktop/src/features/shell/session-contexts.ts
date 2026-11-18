export type SessionContext = { context_id: string; org: string; org_name: string | null; plan: string | null };
export type SessionFamily = { family: string; email: string | null; contexts: SessionContext[] };
export type ContextGroup = SessionContext & { family: string; email: string | null };
export type SessionStatus = { state: string; sessions?: SessionFamily[]; default_context?: string | null };
export type ContextReply = { status: number; body?: unknown };
export type ContextInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export function contextGroups(status: SessionStatus | null): ContextGroup[] | null {
  if (!status || !Array.isArray(status.sessions)) return null;
  const seen = new Set<string>();
  return status.sessions.flatMap((s) => s.contexts.flatMap((c) => {
    if (!c.context_id || !c.org || seen.has(c.context_id)) return [];
    seen.add(c.context_id);
    return [{ ...c, family: s.family, email: s.email }];
  }));
}

/** El portador se queda en Rust; una lectura vieja nunca repone un contexto cerrado. */
export function createSessionContexts(invoke: ContextInvoke, changed: () => void) {
  let groups: ContextGroup[] | null = null;
  let families: SessionFamily[] = [];
  let epoch = 0;
  let unsupported = false;
  let ready = false;
  let connected = false;
  const notify = () => changed();
  async function refresh() {
    const read = ++epoch;
    try {
      const status = await invoke<SessionStatus>("danil_session_status");
      if (read !== epoch) return;
      ready = true;
      connected = status.state === "connected";
      if (unsupported && status.sessions?.some((f) => f.contexts.length)) {
        const context = status.sessions.flatMap((f) => f.contexts)[0].context_id;
        await invoke("danil_edge_fetch", { method: "GET", path: "/v1/identity/me", context });
        if (read !== epoch) return;
      }
      families = status.sessions ?? [];
      groups = contextGroups(status);
      unsupported = false;
      notify();
    } catch { if (read === epoch) { ready = true; notify(); } }
  }
  const send = async (context: string, method: string, path: string, body?: unknown): Promise<ContextReply> => {
    if (unsupported) throw { detail: "session_echo_mismatch" };
    if (!groups?.some((g) => g.context_id === context)) throw { detail: "session_not_in_set" };
    try {
      const reply = await invoke<ContextReply>("danil_edge_fetch", { method, path, context, ...(body === undefined ? {} : { body }), ...(method === "GET" ? {} : { idempotencyKey: crypto.randomUUID() }) });
      if (!groups?.some((g) => g.context_id === context)) throw { detail: "session_not_in_set" };
      return reply;
    } catch (e) {
      if ((e as { detail?: string } | null)?.detail === "session_echo_mismatch") {
        unsupported = true;
        notify();
      }
      throw e;
    }
  };
  async function close(target: { context: string } | { family: string }) {
    await invoke("danil_sign_out", target);
    ++epoch;
    groups = groups?.filter((g) => "context" in target ? g.context_id !== target.context : g.family !== target.family) ?? null;
    families = families.map((f) => ({ ...f, contexts: f.contexts.filter((c) => groups?.some((g) => g.context_id === c.context_id)) }));
    notify();
    await refresh();
  }
  return {
    refresh, send, close, ready: () => ready, connected: () => connected,
    groups: () => unsupported ? null : groups,
    families: () => families,
    addAccount: async () => {
      const result = await invoke<{ error?: string | null }>("danil_sign_in", { mode: "add" });
      await refresh();
      if (result.error) throw { detail: result.error };
    },
  };
}
