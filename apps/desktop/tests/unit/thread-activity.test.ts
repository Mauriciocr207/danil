import assert from "node:assert/strict";
import test from "node:test";
import { activityElapsed, createActivityProjection } from "../../src/features/threads/index.ts";
import type { Msg } from "../../src/features/chat/index.ts";
const message = (text: string, extra: Partial<Msg> = {}): Msg => ({ role: "agent", text, ...extra });

test("explicit start anchors before first output without a native message ID", () => {
  const model = createActivityProjection(), old = message("history", { turno: "old", clave: "old:0" });
  model.begin("A", "s", 1_000);
  const empty = model.project("A", "s", [old])[0];
  assert.equal(empty.anchorIndex, 1); assert.equal(empty.anchor, null);
  const first = message("first"), tool = message("Read", { role: "system", meta: "usó" });
  model.observe("A", "s", [], [first, tool]);
  const activity = model.project("A", "s", [old, first, tool])[0];
  assert.equal(activity.key, empty.key); assert.equal(activity.anchor, first); assert.equal(activity.anchorIndex, 1);
  assert.deepEqual(activity.messages, [first, tool]);
});
test("distinct startsMessage answers with the same native ID keep their own references", () => {
  const model = createActivityProjection(); model.begin("A", "s", 1_000);
  const first = message("one", { nativeMessageId: "same" }), second = message("two", { nativeMessageId: "same" });
  model.observe("A", "s", [], [first, second]);
  assert.deepEqual(model.project("A", "s", [first, second])[0].messages, [first, second]);
});
test("question permission and an injected user never create a turn boundary", () => {
  const model = createActivityProjection(); model.begin("A", "s", 1_000);
  const first = message("first"), steer = message("continue", { role: "user", inyectado: { tras: null } });
  const question = message("", { questionRequestId: "request", preguntas: [] });
  const permission = message("decision", { role: "user" }), last = message("last");
  const rows = [first, steer, question, permission, last]; model.observe("A", "s", [], rows);
  const activities = model.project("A", "s", rows);
  assert.equal(activities.length, 1); assert.equal(activities[0].anchor, first); assert.deepEqual(activities[0].messages, rows);
});
test("done and persisted history preserve the observed activity key and answer order", () => {
  const model = createActivityProjection(); model.begin("A", "s", 1_000);
  const live = message("first"), last = message("last"); model.observe("A", "s", [], [live, last]);
  const key = model.project("A", "s", [live, last])[0].key;
  model.finish("A", "s");
  const saved = [message("first", { clave: "turn:0", avanceDe: "turn" }), message("last", { clave: "turn:1", turno: "turn", duration_ms: 8_000 })];
  model.reconcile("A", "s", [], saved, true);
  const completed = model.project("A", "s", saved)[0];
  assert.equal(completed.key, key); assert.equal(completed.anchor, saved[0]); assert.equal(completed.active, false);
  assert.equal(completed.durationMs, 8_000); assert.deepEqual(completed.messages, saved);
  const reread = saved.map(row => ({ ...row })); model.reconcile("A", "s", saved, reread, false);
  assert.equal(model.project("A", "s", [message("older", { clave: "older:0" }), ...reread])[0].anchorIndex, 1);
});
test("new turn and workspace changes do not reuse another activity identity", () => {
  const model = createActivityProjection(); model.begin("A", "s", 1_000);
  const first = message("first"); model.observe("A", "s", [], [first]); const key = model.project("A", "s", [first])[0].key;
  model.finish("A", "s"); model.begin("A", "s", 2_000); model.begin("B", "s", 2_000);
  assert.notEqual(model.project("A", "s", [first])[1].key, key);
  assert.equal(model.project("A", "s", [first])[0].key, key);
  assert.equal(model.project("B", "s", [first])[0].messages.length, 0);
});
test("elapsed uses the real epoch and unknown start remains unknown", () => {
  assert.equal(activityElapsed(1_000, 6_000), 5_000); assert.equal(activityElapsed(null, 6_000), null);
  assert.equal(activityElapsed(0, 6_000), null); assert.equal(activityElapsed(7_000, 6_000), 0);
  const model = createActivityProjection(); model.begin("A", "s", null);
  assert.equal(model.project("A", "s", [])[0].startedAt, null);
});
test("response text never declares completion and a remount cannot restart elapsed time", () => {
  const model = createActivityProjection(); model.begin("A", "s", 1_000);
  const row = message("Done. Everything finished."); model.observe("A", "s", [], [row]);
  model.begin("A", "s", 90_000);
  const projected = model.project("A", "s", [row])[0]; assert.equal(projected.active, true); assert.equal(projected.startedAt, 1_000);
});
test("draft adoption retains the visible anchor key when started already arrived on its session", () => {
  const model = createActivityProjection(); model.begin("A", "", 1_000);
  const prompt = message("prompt", { role: "user" }); model.observe("A", "", [], [prompt]);
  const key = model.project("A", "", [prompt])[0].key;
  model.begin("A", "s", 1_200); const answer = message("answer"); model.observe("A", "s", [], [answer]);
  model.adopt("A", "", "s"); const activities = model.project("A", "s", [prompt, answer]);
  assert.equal(activities.length, 1); assert.equal(activities[0].key, key); assert.equal(activities[0].anchor, answer);
});
