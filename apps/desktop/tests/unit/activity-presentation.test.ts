import assert from "node:assert/strict";
import test from "node:test";
import "../helpers/catalog.ts";
import { observedActivityAction, presentActivity } from "../../src/features/chat/activityPresentation.ts";
import { pasoDe } from "../../src/lib/steps.ts";

test("stop request suppresses animation and stale action before authoritative completion", () => {
  const action = { kind: "step" as const, step: pasoDe("command_execution", "pnpm test:unit") };
  assert.deepEqual(presentActivity({ active: true, stopping: true, action }), { label: "Deteniendo…", animate: false });
  assert.deepEqual(presentActivity({ active: false, action }), { label: "Actividad finalizada", animate: false });
});

test("a single observed action names its subject without aggregate counts", () => {
  const action = observedActivityAction({ role: "system", text: "Read", paso: { ...pasoDe("Read", "src/features/chat/Chat.tsx"), corriendo: true } });
  assert.equal(presentActivity({ active: true, action }).label, "Leyendo Chat.tsx");
  assert.equal(presentActivity({ active: true, action: observedActivityAction({ role: "agent", text: "", razonamiento: [{ text: "x" }] }) }).label, "Pensando…");
  assert.equal(presentActivity({ active: true, action: observedActivityAction({ role: "agent", text: "previous answer", razonamiento: [{ text: "new reasoning" }] }, "thinking") }).label, "Pensando…");
});

test("unknown recovery cannot invent thinking or a command from queue inputs", () => {
  assert.equal(observedActivityAction({ role: "user", text: "continue" }), null);
  assert.equal(presentActivity({ active: true }).label, "En curso");
  assert.equal(presentActivity({ active: true, blocked: true }).animate, false);
  assert.equal(presentActivity({ active: true, paused: true }).animate, false);
});

for (const corriendo of [false, undefined]) test(`a completed command is not the current work of an active turn (${corriendo})`, () => {
  const action = { kind: "step" as const, step: { ...pasoDe("command_execution", "pwd"), corriendo } };
  assert.deepEqual(presentActivity({ active: true, action }), { label: "Continuando…", animate: true });
  assert.deepEqual(presentActivity({ active: false, action }), { label: "Actividad finalizada", animate: false });
  assert.deepEqual(presentActivity({ active: true, stopping: true, action }), { label: "Deteniendo…", animate: false });
  assert.deepEqual(presentActivity({ active: true, blocked: true, action }), { label: "Actividad", animate: false });
  assert.equal(presentActivity({ active: true, action: { kind: "thinking" } }).label, "Pensando…");
});
