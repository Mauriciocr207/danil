import assert from "node:assert/strict";
import test from "node:test";
import { type ContextInvoke, contextGroups, createSessionContexts, type SessionStatus } from "../../src/features/shell/session-contexts.ts";
import { freeSessionRow, sessionStartTarget, sessionVisible } from "../../src/features/shell/session-rail-view.ts";

const context = (id: string, org = id) => ({ context_id: id, org, org_name: org, plan: "paid" });
const status: SessionStatus = { state: "connected", sessions: [{ family: "one", email: "one@example.com", contexts: [context("a"), context("b"), context("free")] }, { family: "two", email: "two@example.com", contexts: [context("c")] }] };

test("three organizations of one email have separate context keys; old status stays single-session", () => {
  const groups = contextGroups(status)!;
  assert.deepEqual(groups.map((g) => g.context_id), ["a", "b", "free", "c"]);
  assert.equal(new Set(groups.slice(0, 3).map((g) => g.email)).size, 1);
  assert.equal(contextGroups({ state: "connected" }), null);
  assert.deepEqual(contextGroups({ state: "disconnected", sessions: [] }), []);
});

test("calls use the captured context and writes carry idempotency; unknown context never reaches IPC", async () => {
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  const invoke: ContextInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return (command === "danil_session_status" ? status : { status: 204 }) as T;
  };
  const sessions = createSessionContexts(invoke, () => {});
  await sessions.refresh();
  await sessions.send("b", "PUT", "/v1/workspaces/preferences/added/w");
  assert.equal(calls[1].args?.context, "b");
  assert.equal(typeof calls[1].args?.idempotencyKey, "string");
  await assert.rejects(sessions.send("alien", "GET", "/v1/identity/me"), { detail: "session_not_in_set" });
  assert.equal(calls.length, 2);
});

test("missing echo discards multi-session mode and does not return a response body", async () => {
  const invoke: ContextInvoke = async <T>(command: string) => {
    if (command === "danil_session_status") return status as T;
    throw { detail: "session_echo_mismatch" };
  };
  const sessions = createSessionContexts(invoke, () => {});
  await sessions.refresh();
  await assert.rejects(sessions.send("b", "GET", "/v1/workspaces"), { detail: "session_echo_mismatch" });
  assert.equal(sessions.groups(), null);
});

test("closing one context keeps its siblings, another family, local rows and local hidden state", async () => {
  let current = structuredClone(status);
  const invoke: ContextInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
    if (command === "danil_sign_out") current.sessions![0].contexts = current.sessions![0].contexts.filter((c) => c.context_id !== args?.context);
    return current as T;
  };
  const sessions = createSessionContexts(invoke, () => {});
  await sessions.refresh();
  await sessions.close({ context: "a" });
  assert.deepEqual(sessions.groups()!.map((g) => g.context_id), ["b", "free", "c"]);
  const groups = sessions.groups()!.map((g) => ({ ...g, person: "person", available: [{ id: g.org, name: g.org }], added: new Set([g.org]) }));
  const rows = ["a", "local", "hidden"].map((id) => ({ id, name: id, logo: null }));
  const hidden = new Set(["hidden"]);
  assert.deepEqual(sessionVisible(rows, "a", hidden, groups, new Set(["a", "b", "free", "c"])).map((w) => w.id), ["local", "b", "free", "c"]);
  assert.deepEqual([...hidden], ["hidden"]);
});

test("a late status read cannot undo a newer set", async () => {
  let finish!: (value: SessionStatus) => void;
  let calls = 0;
  const invoke: ContextInvoke = async <T>() => (++calls === 1 ? await new Promise<SessionStatus>((r) => { finish = r; }) : { state: "disconnected", sessions: [] }) as T;
  const sessions = createSessionContexts(invoke, () => {});
  const old = sessions.refresh();
  await sessions.refresh();
  finish(status);
  await old;
  assert.deepEqual(sessions.groups(), []);
});

test("closing an email leaves another email intact; cancelling account addition does too", async () => {
  let current = structuredClone(status);
  const invoke: ContextInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
    if (command === "danil_sign_out") current.sessions = current.sessions!.filter((f) => f.family !== args?.family);
    if (command === "danil_sign_in") { assert.equal(args?.mode, "add"); return { error: "cancelled" } as T; }
    return current as T;
  };
  const sessions = createSessionContexts(invoke, () => {});
  await sessions.refresh();
  await assert.rejects(sessions.addAccount(), { detail: "cancelled" });
  assert.equal(sessions.groups()!.length, 4);
  await sessions.close({ family: "one" });
  assert.deepEqual(sessions.groups()!.map((g) => g.context_id), ["c"]);
});

test("an edge response arriving after logout never reaches its old group", async () => {
  let finish!: (value: { status: number; body: unknown }) => void;
  let current = structuredClone(status);
  const invoke: ContextInvoke = async <T>(command: string) => {
    if (command === "danil_edge_fetch") return await new Promise((r) => { finish = r; }) as T;
    if (command === "danil_sign_out") current = { state: "disconnected", sessions: [] };
    return current as T;
  };
  const sessions = createSessionContexts(invoke, () => {});
  await sessions.refresh();
  const pending = sessions.send("a", "GET", "/v1/workspaces");
  await sessions.close({ context: "a" });
  finish({ status: 200, body: { secret: "old tenant" } });
  await assert.rejects(pending, { detail: "session_not_in_set" });
});

test("two preference synchronizers keep person/org records and their own IPC context", async () => {
  const { createAddedSync } = await import("../../src/features/shell/workspace-added-sync.ts");
  const { edgeAddedTransport, prefsAddedStore } = await import("../../src/features/shell/workspace-added-transport.ts");
  const calls: string[] = [];
  const invoke: ContextInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
    if (command === "danil_session_status") return status as T;
    calls.push(String(args?.context));
    return { status: 200, body: { version: 1, added: [args?.context] } } as T;
  };
  const sessions = createSessionContexts(invoke, () => {});
  await sessions.refresh();
  let preferences: unknown = {};
  const store = prefsAddedStore(() => preferences, (next) => { preferences = next; });
  const synchronizers = ["a", "b"].map((id) => createAddedSync({
    transport: edgeAddedTransport((method, path, body) => sessions.send(id, method, path, body)),
    store, scope: () => ({ person: "same-person", organization: id }),
    available: () => [{ id, name: id }], shown: () => new Set<string>(), hidden: () => new Set<string>(), onChange: () => {},
  }));
  await Promise.all(synchronizers.map((sync) => sync.sync()));
  assert.deepEqual(calls.sort(), ["a", "b"]);
  assert.deepEqual([...synchronizers[0].added()!], ["a"]);
  assert.deepEqual([...synchronizers[1].added()!], ["b"]);
});

test("the Free menu row needs resolved E1/W1a data; no classification from a name", () => {
  assert.equal(freeSessionRow({ plan: "free" }), null);
  assert.equal(freeSessionRow({ plan: "paid", free: { id: "local", name: "Free" } }), null);
  const free = { id: "server-engine-id", name: "Personal" };
  assert.deepEqual(freeSessionRow({ plan: "free", free }), free);
});

test("the initial engine selection cannot open an unadded organization workspace", () => {
  const group = { ...context("a"), family: "one", email: null, person: "person", available: [{ id: "unadded", name: "New" }, { id: "added", name: "Added" }], added: new Set(["added"]) };
  assert.equal(sessionStartTarget([{ id: "local" }], "unadded", new Set(), [group]), "added");
  assert.equal(sessionStartTarget([{ id: "local" }], "unadded", new Set(), [{ ...group, added: new Set<string>() }]), "local");
  assert.equal(sessionStartTarget([{ id: "local" }], "unadded", new Set(), [{ ...group, added: null }]), null);
});
