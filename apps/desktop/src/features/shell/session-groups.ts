import { createEffect, createMemo, createRoot, createSignal, on } from "solid-js";
import { invoke } from "../../lib/invoke.ts";
import { capabilities } from "../../lib/platform.ts";
import { escribirPref, leerPref } from "../../lib/prefs.ts";
import { listen } from "../../lib/serviceEvents.ts";
import { danilAvailable, readDanil } from "../machines/index.ts";
import { type ContextGroup, createSessionContexts } from "./session-contexts.ts";
import { coalesceSessionReturn } from "./session-return.ts";
import { sessionSeedInputs, sessionSyncKey } from "./session-seeding.ts";
import { createAddedSync } from "./workspace-added-sync.ts";
import { ADDED_KEY, edgeAddedTransport, prefsAddedStore } from "./workspace-added-transport.ts";

export type SessionRailGroup = ContextGroup & { available: readonly { id: string; name: string }[] | null; added: ReadonlySet<string> | null; person: string | null; free?: { id: string; name: string } };
let instance: ReturnType<typeof wire> | undefined;
export const hasSessionGroups = () => !!instance?.groups();
export const sessionRail = (hidden: () => ReadonlySet<string>, seeded: (ids: readonly string[]) => void) => instance ??= createRoot(() => wire(hidden, seeded));

function wire(hidden: () => ReadonlySet<string>, onSeeded: (ids: readonly string[]) => void) {
  const [revision, bump] = createSignal(0);
  const changed = () => bump((n) => n + 1);
  const sessions = createSessionContexts(invoke, changed);
  const groups = () => (revision(), sessions.groups());
  const [laterContext, setLaterContext] = createSignal<string | null>(null);
  const records = new Map<string, { person: string | null; asking: boolean; sync: ReturnType<typeof createAddedSync> }>();
  const known = new Set<string>();
  const active = (id: string) => groups()?.find((g) => g.context_id === id);
  const store = prefsAddedStore(() => leerPref<unknown>(ADDED_KEY, {}), (all) => escribirPref(ADDED_KEY, all));
  const ensure = (g: ContextGroup) => {
    const existing = records.get(g.context_id);
    if (existing?.person || existing?.asking) return;
    if (!existing && g.workspaces === "later") setLaterContext(g.context_id);
    const record = existing ?? { person: null as string | null, asking: false, sync: null as unknown as ReturnType<typeof createAddedSync> };
    if (!existing) record.sync = createAddedSync({
      transport: edgeAddedTransport((method, path, body) => sessions.send(g.context_id, method, path, body)),
      store,
      scope: () => record.person && active(g.context_id) ? { person: record.person, organization: g.org } : null,
      available: () => active(g.context_id) ? danilAvailable(g.org) : null,
      shown: () => sessionSeedInputs(active(g.context_id), danilAvailable(g.org), new Set([...leerPref<string[]>("workspaces.order", []), ...(capabilities().railWorkspaces?.() ?? []).map((w) => w.id)]), hidden()).shown,
      hidden: () => sessionSeedInputs(active(g.context_id), danilAvailable(g.org), new Set(), hidden()).hidden,
      onSeeded, onChange: changed,
    });
    records.set(g.context_id, record);
    record.asking = true;
    void sessions.send(g.context_id, "GET", "/v1/identity/me").then((r) => {
      const id = (r.body as { id?: unknown } | null)?.id;
      if (r.status === 200 && typeof id === "string" && active(g.context_id)) {
        record.person = id;
        changed();
        void record.sync.sync();
      }
    }).catch(() => {}).finally(() => { record.asking = false; });
  };
  const rows = createMemo(() => groups()?.map((g): SessionRailGroup => {
    const available = danilAvailable(g.org);
    for (const w of available ?? []) known.add(w.id);
    return { ...g, available, added: records.get(g.context_id)?.sync.added() ?? null, person: records.get(g.context_id)?.person ?? null };
  }) ?? null);
  createEffect(() => {
    for (const g of groups() ?? []) ensure(g);
  });
  const syncKey = createMemo(() => sessionSyncKey(rows() ?? []));
  createEffect(on(syncKey, () => {
    for (const g of rows() ?? []) if (g.available && g.person) void records.get(g.context_id)?.sync.sync();
  }));
  if (capabilities().nativeWindow) {
    void sessions.refresh();
    void listen("danil-connect", () => void sessions.refresh()).catch(() => {});
    const returned = coalesceSessionReturn(sessions.refresh);
    window.addEventListener("focus", returned);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") returned();
    });
  }
  return {
    sessions, groups: rows, known, laterContext, acknowledgeLater: () => setLaterContext(null), ready: () => (revision(), sessions.ready()), connected: () => (revision(), sessions.connected()),
    add: (context: string, id: string) => records.get(context)?.sync.add(id),
    remove: (context: string, id: string) => records.get(context)?.sync.remove(id),
    refresh: () => { for (const g of groups() ?? []) void readDanil(g.org); },
  };
}
