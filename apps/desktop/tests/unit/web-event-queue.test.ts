import assert from "node:assert/strict";
import test from "node:test";
import { createWebEventQueue } from "../../src/features/machines/web-event-queue.ts";

test("a pending web poll wakes immediately and close settles a later reader", async () => {
  const queue = createWebEventQueue();
  const pending = queue.poll();
  queue.push([{ name: "chat", payload: { session: "s", kind: "delta", text: "progress" } }], { replay: true, replayId: "one", cursor: 9 });
  const result = await pending;
  assert.equal(result.batches?.[0].replayId, "one"); assert.equal(result.gap, false);
  const final = queue.poll(); queue.close();
  assert.deepEqual((await final).batches, []);
  queue.push([{ name: "chat", payload: "late" }]); assert.deepEqual((await queue.poll()).batches, []);
});

test("overflow and remote gaps request reconciliation instead of silently dropping a journal", async () => {
  const queue = createWebEventQueue(80);
  queue.push([{ name: "chat", payload: "x".repeat(80) }]);
  const over = await queue.poll(); assert.equal(over.gap, true); assert.deepEqual(over.batches, []);
  queue.push([], { gap: true }); assert.equal((await queue.poll()).gap, true);
  queue.close();
});
