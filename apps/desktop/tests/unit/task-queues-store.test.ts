import assert from "node:assert/strict";
import test from "node:test";
import { createRoot, createSignal } from "solid-js";
import { createTaskQueues, type QueueScope } from "../../src/features/task-queues/index.ts";
import type { Encolado } from "../../src/features/chat/index.ts";
const message = (id: string, text = id): Encolado => ({ id, text, provider: "codex", model: null, effort: null, permission_mode: null, attachments: [] });
function fixture(read: (scope: QueueScope) => Promise<Encolado[]> = async () => []) {
  return createRoot(dispose => {
    const [scope, setScope] = createSignal<QueueScope>({ workspace: "A", generation: 1, session: "s1", project: "p1" });
    const writes: { scope: QueueScope; items: Encolado[] }[] = [], failures: unknown[] = [];
    const queue = createTaskQueues({ scope, readQueue: read, writeQueue: async (scope, items) => { writes.push({ scope, items }); }, onSaveFailure: error => { failures.push(error); } });
    return { queue, scope, setScope, writes, failures, dispose };
  });
}
test("detach empties hand without overwriting departed session", async () => {
  const f = fixture(); await f.queue.openSession("s1", "p1"); f.queue.enqueue(message("a"));
  const writes = f.writes.length; f.queue.detach(); assert.equal(f.writes.length, writes);
  assert.deepEqual(f.queue.saved("s1")?.items.map(item => item.id), ["a"]); f.dispose();
});
test("disk queue is retained as draft while memory copy takes precedence", async () => {
  let reads = 0; const f = fixture(async () => { reads++; return [message("disk")]; });
  await f.queue.openSession("s1", "p1"); assert.equal(f.queue.retained(), "borrador");
  f.queue.retain(null); f.queue.enqueue(message("fresh")); f.queue.detach();
  await f.queue.openSession("s1", "p1"); assert.equal(reads, 1); assert.deepEqual(f.queue.items().map(item => item.id), ["disk", "fresh"]); assert.equal(f.queue.retained(), null); f.dispose();
});
test("late read across A B A cannot adopt old queue", async () => {
  let resolve!: (items: Encolado[]) => void; const f = fixture(() => new Promise(done => { resolve = done; }));
  const reading = f.queue.openSession("s1", "p1"); f.queue.workspaceChanged("A"); f.setScope({ ...f.scope(), workspace: "B", generation: 2 });
  f.queue.workspaceChanged("B"); f.setScope({ ...f.scope(), workspace: "A", generation: 3 }); resolve([message("late")]); await reading;
  assert.deepEqual(f.queue.items(), []); assert.equal(f.queue.owner(), null); f.dispose();
});
test("next obeys task ownership, busy, editing, waiting and all retention reasons", async () => {
  const f = fixture(); await f.queue.openSession("s1", "p1"); f.queue.enqueue(message("a"));
  for (const reason of ["fallo", "pregunta", "session", "borrador"] as const) { f.queue.retain(reason); assert.equal(f.queue.next({ busy: false, waiting: false }), null); }
  f.queue.retain(null); assert.equal(f.queue.next({ busy: true, waiting: false }), null);
  f.queue.editMode(true); assert.equal(f.queue.next({ busy: false, waiting: false }), null); f.queue.editMode(false);
  assert.equal(f.queue.next({ busy: false, waiting: true }), null); f.setScope({ ...f.scope(), session: "s2" }); assert.equal(f.queue.next({ busy: false, waiting: false }), null); f.dispose();
});
test("dispatch removes only the selected homogeneous batch", async () => {
  const f = fixture(); await f.queue.openSession("s1", "p1"); f.queue.enqueue(message("a"));
  f.queue.enqueue({ ...message("b"), agent: "other" });
  const next = f.queue.next({ busy: false, waiting: false }); assert.equal(next?.kind, "message");
  assert.deepEqual(f.queue.items().map(item => item.id), ["b"]); f.dispose();
});
test("hidden rollback preserves new entries and rejects an old workspace batch", async () => {
  const f = fixture(); await f.queue.openSession("s1", "p1"); f.queue.enqueue(message("a")); f.queue.detach(); f.setScope({ ...f.scope(), session: "s2" });
  const batch = f.queue.beginHidden("s1", false); assert.ok(batch);
  assert.equal(f.queue.beginHidden("s1", false), null); assert.deepEqual(f.queue.restoreHidden(batch, "fallo")?.map(item => item.id), ["a"]);
  f.queue.workspaceChanged("A"); f.setScope({ ...f.scope(), workspace: "B", generation: 2 });
  assert.equal(f.queue.restoreHidden(batch, "fallo"), null); f.dispose();
});
test("shell stays queued until its runtime acknowledges it", async () => {
  const f = fixture(); await f.queue.openSession("s1", "p1"); f.queue.enqueue(message("shell", "!pwd"));
  assert.equal(f.queue.next({ busy: false, waiting: false })?.kind, "shell"); assert.equal(f.queue.items().length, 1); f.dispose();
});
test("live disk draft releases but explicit failed queue stays retained", async () => {
  const f = fixture(async () => [message("disk")]); await f.queue.openSession("s1", "p1");
  f.queue.releaseDiskDraft("s1", true); assert.equal(f.queue.retained(), null); f.queue.retain("fallo"); f.queue.releaseDiskDraft("s1", true); assert.equal(f.queue.retained(), "fallo"); f.dispose();
});

test("old same-workspace task reopen cannot replace a fresh read", async () => {
  const resolves: ((rows: Encolado[]) => void)[] = [];
  const f = fixture(() => new Promise(done => resolves.push(done)));
  const old = f.queue.openSession("s1", "p1"); f.queue.detach();
  f.setScope({ ...f.scope(), session: "s2" }); f.queue.detach(); f.setScope({ ...f.scope(), session: "s1" });
  const fresh = f.queue.openSession("s1", "p1"); resolves[0]([message("obsolete")]); await old;
  resolves[1]([message("fresh")]); await fresh; assert.deepEqual(f.queue.items().map(item => item.id), ["fresh"]); f.dispose();
});
