import assert from "node:assert/strict";
import test from "node:test";
import { sleep } from "../helpers/jsdom-app.mjs";
import { boot, TASK_AFTER_QUEUE } from "../helpers/mount-guard.mjs";

test("el hilo conserva sus separadores de interrupción, actualización, traspaso y cupo", async () => {
  const app = await boot("listo", "chat-system-markers", {
    ...TASK_AFTER_QUEUE,
    load_session: { ...TASK_AFTER_QUEUE.load_session, turns: [
      { role: "agent", id: "before", text: "Antes." },
      { role: "system", id: "handover", meta: "provider_handover",
        text: "La tarea pasó de Claude a Codex." },
      { role: "system", id: "cancelled", meta: "fallo", text: "chat.turn.cancelled" },
      { role: "system", id: "updated", meta: "engine_updated", text: "chat.engine_updated" },
      { role: "system", id: "switched", meta: "cupo", text: "Cambio de cupo", quota: { from: "Cuenta 1", to: "Cuenta 2" } },
      { role: "system", id: "resumed", meta: "cupo", text: "Cambio de cupo", quota: { from: "Cuenta 1" } },
      { role: "agent", id: "after", text: "Después." },
    ] },
  });
  const doc = app.w.document;
  doc.querySelector('[data-sesion="s1"]').click();
  await sleep(150);
  const statuses = [...doc.querySelectorAll('[role="status"]')];
  assert.ok(statuses.some((row) => row.textContent === "Interrumpido"));
  assert.ok(statuses.some((row) => row.textContent === "Siguió tras actualizar Danil a mitad del turno"));
  const handover = doc.querySelector("[data-provider-handover]");
  assert.equal(handover?.getAttribute("role"), "status");
  assert.equal(handover?.textContent.trim(), "La tarea pasó de Claude a Codex.");
  const switched = doc.querySelector('[data-quota-row="switched"]');
  assert.equal(switched?.textContent.trim(), "Se acabó el cupo de Cuenta 1; la tarea siguió con Cuenta 2.");
  assert.ok(switched?.classList.contains("text-info-strong"));
  const resumed = doc.querySelector('[data-quota-row="resumed"]');
  assert.equal(resumed?.textContent.trim(), "Volvió el cupo de Cuenta 1; la tarea sigue.");
  assert.ok(resumed?.classList.contains("text-neutral-500"));
  assert.ok(doc.body.textContent.includes("Antes."));
  assert.ok(doc.body.textContent.includes("Después."));
  assert.deepEqual(app.failures, []);
});
