import assert from "node:assert/strict";
import test from "node:test";
import { HOME, open, openTask, row, until } from "../helpers/desktop-account.mjs";

test("a delegated reference without task metadata never fabricates a date or native task actions", async () => {
  const reference = { folder: "p1", task: "/root/history_hotfix", title: "Referencia de hotfix", provider: "codex" };
  const parent = { ...row("parent", "Padre de referencia"), turns: 1, has_delegates: true };
  const fixture = await open("delegated-reference-metadata", { computers: [HOME], extra: {
    project_base_branches: [],
    list_live_sessions: () => [parent],
    list_delegated_sessions: [],
    load_session: () => ({ id: "parent", provider: "codex", sources: [], model: "gpt-5.6", turns: [
      { role: "system", id: "launch", text: "", meta: "task_launched", from_task: reference },
    ] }),
  } });
  try {
    assert.ok(await until(() => fixture.doc.querySelector('[data-sesion="parent"]')));
    await openTask(fixture.app, "parent");
    const selector = '[data-delegated-launch="/root/history_hotfix"]';
    assert.ok(await until(() => fixture.doc.querySelector(selector)));
    const launch = fixture.doc.querySelector(selector);
    assert.equal(launch.querySelector("[data-session-time]"), null, "unknown metadata is not epoch zero");
    assert.equal(launch.querySelector('[data-sesion="/root/history_hotfix"]'), null, "a reference is not a discovered native task row");
    assert.ok(launch.querySelector('[data-delegated-reference="/root/history_hotfix"]'));
    assert.ok(launch.textContent.includes(reference.title));
    assert.equal(launch.querySelector("button, a, [role=button]"), null, "unresolved references cannot launch fabricated task actions");
    assert.equal(launch.querySelector("p"), null, "absence of metadata alone does not prove the task unavailable");
    assert.deepEqual(fixture.app.failures, []);
  } finally { fixture.app.w.close(); }
});
