import assert from "node:assert/strict";
import test from "node:test";
import { createRoot } from "solid-js";
import { createBatchDelivery } from "../../src/features/service-stream/index.ts";
import { createThreadsStore } from "../../src/features/threads/index.ts";
import { createRouter } from "../../src/features/machines/router.ts";
import { Fleet } from "@terminus/fleet";
import type { ChatEvent, Session } from "../../src/features/chat/index.ts";
import type { PushedBatch } from "../../src/features/service-stream/index.ts";

test("a delayed history read and replay use durable IDs while equal new output remains legitimate", async () => {
  await createRoot(async dispose => {
    const saved = { id: "saved-one", role: "agent", text: "same answer" }, old = { turns: [saved], provider: "codex" } as Session;
    let finish!: (session: Session) => void;
    const threads = createThreadsStore({ scope: { workspace: () => "w", generation: () => 1, paged: () => false }, activeSession: () => "s", project: () => "p",
      invoke: async <T>() => new Promise<Session>(resolve => { finish = resolve; }) as Promise<T>, route: () => undefined, liveThreads: () => new Set() });
    const router = createRouter({ self: null, fleet: new Fleet({ self: null, connect: () => { throw new Error("not used"); } }), native: null });
    let lifecycle = 0;
    const deliver = createBatchDelivery({ resync: () => {}, replay: threads.replay, deliver: events => {
      for (const event of events) {
        const fact = event.payload as ChatEvent;
        if (fact.kind === "started" || fact.kind === "done") lifecycle++;
        threads.event(fact, { author: null });
      }
    } });
    const event = (kind: ChatEvent["kind"], text: string, fields: Partial<ChatEvent> = {}) => ({ name: "chat", payload: { workspace: "w", session: "s", kind, text, meta: null, ...fields } });
    const poll = async () => deliver((await router.handle("service_poll") as { batches: PushedBatch[] }).batches);
    try {
      threads.acceptSession("s", old, true, 1);
      const slow = threads.read("p", "s");
      router.events("m", [...Array.from({ length: 20 }, () => [event("started", ""), event("done", "", { ok: true })]).flat(),
        event("delta", saved.text, { starts_message: true, message_id: "native-one" }), event("segment_saved", "", { id: saved.id })], { replay: true, replayId: "subscription-one", cursor: 40 });
      await poll();
      assert.equal(lifecycle, 0, "historical lifecycle cannot fan out into fresh task/status reads");
      assert.equal(threads.messages().filter(row => row.text === saved.text).length, 1);
      finish(old); threads.acceptSession("s", await slow, false, 1);
      threads.beginActivity("s", 1000);
      router.events("m", [event("delta", saved.text, { starts_message: true, message_id: "native-two" })], { replay: false, cursor: 41 });
      await poll(); threads.flush();
      assert.equal(threads.messages().filter(row => row.text === saved.text).length, 2, "two distinct native executions can legitimately say the same thing");
    } finally { router.close(); threads.dispose(); dispose(); }
  });
});
