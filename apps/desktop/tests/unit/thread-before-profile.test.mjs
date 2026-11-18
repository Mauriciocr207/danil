import assert from "node:assert/strict";
import test from "node:test";
import { HOME, open, openTask, row, until } from "../helpers/desktop-account.mjs";

test("the received conversation paints while its optional agent profile is still pending", async () => {
  let delivered = false, requested = false, finishProfile;
  const profile = new Promise(resolve => { finishProfile = resolve; });
  const history = "Historia recibida antes del perfil";
  const fixture = await open("thread-before-profile", { computers: [HOME], extra: {
    project_base_branches: [],
    list_live_sessions: () => [row("parent", "Conversación del encargado")],
    list_agent_profiles: () => {
      if (!delivered) return {};
      requested = true;
      return profile;
    },
    load_session: () => {
      delivered = true;
      return { id: "parent", provider: "codex", agent: "orchestrator", chat_de_agente: true, sources: [], model: "gpt-5.6", turns: [
        { role: "user", id: "question", text: history },
      ] };
    },
  } });
  try {
    assert.ok(await until(() => fixture.doc.querySelector('[data-sesion="parent"]')));
    await openTask(fixture.app, "parent");
    assert.ok(await until(() => requested), "the optional profile read is in flight");
    assert.ok(await until(() => [...fixture.doc.querySelectorAll("[data-chat-thread]")].some(thread => thread.textContent.includes(history))), "history must paint before the optional profile resolves");
    finishProfile({});
    assert.deepEqual(fixture.app.failures, []);
  } finally { finishProfile({}); fixture.app.w.close(); }
});
