import { announcesOrganizations, type OrganizationSource } from "@terminus/computers";
import type { platformSession, platformTransport } from "./platform-session.ts";
import { PlatformSessionError } from "./platform-session.ts";
import { webAccountProfile } from "./account.ts";
import { workspaceSelection } from "./workspace-selection.ts";
import { type CapabilitiesSnapshot, readCapabilities } from "./service-capabilities.ts";
import { webOrganizationSource } from "./organizations.ts";

/** Prefetch failures remain observable without an unhandled rejection before their consumer arrives. */
function shared<T>(read: () => Promise<T>) {
  let result: Promise<{ value: T } | { error: unknown }> | undefined;
  return () => {
    result ??= read().then(value => ({ value }), error => ({ error }));
    return result.then(reply => { if ("error" in reply) throw reply.error; return reply.value; });
  };
}

/** One startup attempt owns its snapshot; a retry or selection creates a fresh reader. */
export function startupReader(api: Pick<ReturnType<typeof platformSession>, "me" | "workspaces">, transport: ReturnType<typeof platformTransport>) {
  const me = shared(() => api.me());
  const response = shared(() => transport.call("capabilities"));
  const body = shared(async () => {
    const reply = await response();
    return reply.status === 404 || reply.status === 501 ? null : reply.clone().json();
  });
  const capabilities = shared(() => readCapabilities({ call: async () => (await response()).clone() }));
  const source = webOrganizationSource(transport);
  const list = shared(() => source.list());
  const prefetch = shared(async () => {
    if (announcesOrganizations(await body())) await list();
  });
  // Capture each eager outcome now; callers still receive the original error when they consume it.
  void me().catch(() => undefined);
  void capabilities().catch(() => undefined);
  void prefetch().catch(() => undefined);
  const organizations: OrganizationSource = { ...source, capabilities: body, list };
  return { me, capabilities, workspaces: shared(() => api.workspaces()), organizations };
}


/** Selection receipts are reconciled before the next attempt captures its identity snapshot. */
export function sessionStartup(api: Pick<ReturnType<typeof platformSession>, "me" | "workspaces" | "select">, transport: ReturnType<typeof platformTransport>, now: () => number = Date.now) {
  let refreshAt = 0;
  let reader: ReturnType<typeof startupReader> | undefined;
  const selection = workspaceSelection({
    active: async () => (await (reader?.me() ?? api.me())).workspace,
    select: (id, key) => { reader = undefined; return api.select(id, key); },
  });
  const checked = () => { refreshAt = now() + 5 * 60_000; };
  function accountProfile(signal: AbortSignal) {
    const candidate = reader;
    const expiresAt = refreshAt;
    let initial = reader?.me();
    return webAccountProfile({ call: async path => {
      signal.throwIfAborted();
      if (!initial || candidate !== reader || now() >= expiresAt) { initial = undefined; return transport.call(path); }
      const snapshot = initial; initial = undefined;
      const profile = await snapshot;
      signal.throwIfAborted();
      if (candidate !== reader || now() >= expiresAt) return transport.call(path);
      return Response.json(profile);
    } });
  }
  return { selection, reader: () => reader, refreshDue: () => now() >= refreshAt, refreshIn: () => Math.max(0, refreshAt - now()), checked, accountProfile, async read(previousCapabilities: CapabilitiesSnapshot | null) {
    if (selection.uncertain()) await selection.reconcile();
    reader = startupReader(api, transport);
    const [profile, capabilities] = await Promise.all([reader.me(), reader.capabilities().catch(cause => {
      if (cause instanceof PlatformSessionError && cause.status === 401) throw cause;
      return previousCapabilities;
    })]);
    await selection.reconcile();
    checked();
    return { profile, capabilities };
  } };
}
