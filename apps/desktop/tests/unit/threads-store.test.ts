import assert from "node:assert/strict";
import test from "node:test";
import { createRoot, createSignal } from "solid-js";
import { createThreadsStore } from "../../src/features/threads/index.ts";
import type { ChatEvent, Msg, Session } from "../../src/features/chat/index.ts";

const msg = (text: string, role: Msg["role"] = "agent"): Msg => ({ role, text });
const session = (turns: Session["turns"] = [], extra: Partial<Session> = {}): Session => ({ turns, provider: "claude", ...extra }) as Session;
const metadata = { author: null };
const event = (kind: ChatEvent["kind"], text: string, extra: Partial<ChatEvent> = {}): ChatEvent => ({ kind, text, session: "s", meta: null, ...extra });
function fixture(read?: Parameters<typeof createThreadsStore>[0]["invoke"]) {
  return createRoot(dispose => {
    const [workspace, setWorkspace] = createSignal<string | null>("A");
    const [activeSession, setActive] = createSignal<string | null>("s");
    let generation = 1;
    const live = new Set<string>(); const calls: unknown[] = [];
    const store = createThreadsStore({ scope: { workspace, generation: () => generation, paged: () => false }, activeSession, project: () => "p",
      invoke: async <T>(command: string, args?: Record<string, unknown>, options?: { headers?: Record<string, string> }) => { calls.push({ command, args, options }); return read ? read<T>(command, args, options) : session() as T; },
      route: () => ({ headers: { "x-terminus-machine": "m1" } }), liveThreads: () => live });
    return { store, live, calls, setActive, generation: () => generation,
      move: (id: string) => { store.saveWorkspace(workspace()); generation++; setWorkspace(id); store.activateWorkspace(id); },
      dispose: () => { store.dispose(); dispose(); } };
  });
}

test("queued deltas flush before a tool fact and unrelated thread identity survives", () => {
  const f = fixture(); f.store.appendLive("other", [msg("unchanged")]); const other = f.store.rows().other;
  f.store.event(event("delta", "hello"), metadata); f.store.event(event("tool", "Read", { id: "tool1", target: "file" }), metadata);
  const painted = f.store.rows().s.vivo;
  assert.equal(painted[0].text, "hello"); assert.equal(painted[1].paso?.corriendo, true); assert.equal(f.store.rows().other, other);
  f.store.event(event("tool_done", "Read", { id: "tool1", ok: true }), metadata);
  assert.equal(f.store.rows().s.vivo[1].paso?.corriendo, false); f.dispose();
});

test("persisted history keeps question reply routing and removes the duplicate live turn", () => {
  const f = fixture(); f.store.appendLive("s", [msg("answer")]);
  f.store.question("s", { turno: "turn1", questionRequestId: "request1" });
  f.store.replaceHistory("s", [{ ...msg("persisted"), turno: "turn1" }], false);
  assert.equal(f.store.rows().s.base[0].questionRequestId, "request1"); assert.deepEqual(f.store.rows().s.vivo, []);
  const base = f.store.rows().s.base; f.store.replaceHistory("s", [{ ...msg("persisted"), turno: "turn1" }], false);
  assert.equal(f.store.rows().s.base, base); f.dispose();
});

test("replay keeps human messages and optimistic adoption retains events already received", () => {
  const f = fixture(); const human = msg("pending", "user");
  f.store.appendPersisted("", [human]); f.store.appendLive("s", [msg("stream")]); f.store.adoptDraft("s");
  assert.equal(f.store.rows().s.base[0], human); assert.equal(f.store.rows().s.vivo[0].text, "stream");
  f.store.appendLive("s", [msg("steer", "user")]); f.store.replay("s");
  assert.equal(f.store.rows().s.vivo.length, 1); assert.equal(f.store.rows().s.vivo[0].text, "steer"); f.dispose();
});

test("workspace switches retain only live threads, including their background updates", () => {
  const f = fixture(); f.store.appendLive("s", [msg("A")]); f.store.appendLive("closed", [msg("discard")]); f.live.add("A/s");
  f.move("B"); f.store.appendLive("s", [msg("B")]); f.store.appendLive("s", [msg("A background")], "A"); f.move("A");
  assert.deepEqual(f.store.rows().s.vivo.map(row => row.text), ["A", "A background"]); assert.equal(f.store.rows().closed, undefined); f.dispose();
});

test("optimistic updates and rejection affect only their own message references", () => {
  const f = fixture(); const optimistic = msg("own", "user"), other = msg("other", "user"); f.store.appendPersisted("s", [optimistic, other]);
  f.store.reviseOptimistic("s", optimistic, { author: null }); assert.notEqual(f.store.rows().s.base[0], optimistic); assert.equal(f.store.rows().s.base[1], other);
  f.store.rejectOptimistic("s", [other]); assert.equal(f.store.rows().s.base.length, 1); f.dispose();
});

test("a read pins its machine/workspace and old generations cannot accept it", async () => {
  let resolve!: (value: Session) => void; const f = fixture(async <T>() => new Promise<Session>(yes => { resolve = yes; }) as Promise<T>);
  const generation = f.generation(), pending = f.store.read("p", "s"); f.move("B"); resolve(session()); const result = await pending;
  assert.deepEqual((f.calls[0] as { options: unknown }).options, { headers: { "x-terminus-machine": "m1", "x-terminus-workspace": "A" } });
  assert.equal(f.store.acceptSession("s", result, false, generation), false); assert.equal(f.store.rows().s, undefined); f.dispose();
});

test("an older page that returns after a workspace change cannot paint the new workspace", async () => {
  let resolve!: (value: Session) => void;
  const f = fixture(async <T>() => new Promise<Session>(yes => { resolve = yes; }) as Promise<T>);
  const page = { version: 1, start: 1, end: 2, total: 2, limit: 1, has_more: true };
  f.store.acceptSession("s", session([{ id: "new", role: "user", text: "new" }], { history: page }), false, f.generation());
  const pending = f.store.older("p", "s"); f.move("B");
  resolve(session([{ id: "old", role: "user", text: "old" }], { history: { ...page, start: 0, end: 1, has_more: false } }));
  assert.equal(await pending, null); assert.equal(f.store.rows().s, undefined); f.dispose();
});

test("metadata, loading and waking belong to the accepted task; finishing another load does not hide it", () => {
  const f = fixture(); f.store.startLoading("s"); f.store.startLoading("next"); f.store.finishLoading("s"); assert.equal(f.store.loading(), "next");
  assert.equal(f.store.acceptSession("s", session([], { offline: { machine: "m1" }, can_hand_over: true }), false, f.generation()), true);
  assert.equal(f.store.offline().s, "m1"); assert.equal(f.store.handovers().s.can, true);
  f.store.markWaking("s", "m1"); assert.equal(f.store.waking().s, "m1"); f.store.markAwake("s"); assert.equal(f.store.offline().s, undefined); f.dispose();
});

test("service reset clears live output and retained streams while keeping persisted messages", () => {
  const f = fixture(); const base = msg("saved"); f.store.appendPersisted("s", [base]); f.store.appendLive("s", [msg("live")]);
  f.store.resetService(); assert.equal(f.store.rows().s.base[0], base); assert.deepEqual(f.store.rows().s.vivo, []); f.dispose();
});

test("disposal rejects fresh reads and ignores a queued delta and late history", async () => {
  const f = fixture(); const generation = f.generation(); f.store.event(event("delta", "late"), metadata); f.store.dispose();
  assert.equal(f.store.acceptSession("s", session(), false, generation), false); assert.equal(f.store.rows().s, undefined);
  f.store.appendLive("s", [msg("late")]); assert.equal(f.store.rows().s, undefined);
  await assert.rejects(f.store.read("p", "s"), { name: "AbortError" }); f.dispose();
});

test("presence and empty painting facts do not create conversation rows", () => {
  const f = fixture();
  for (const kind of ["presence", "started", "task_launched", "segment_saved", "image"] as const) f.store.event(event(kind, ""), metadata);
  assert.deepEqual(f.store.rows(), {}); f.dispose();
});
