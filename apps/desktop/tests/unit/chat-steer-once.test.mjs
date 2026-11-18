/** Automatic background delivery is injected once and reconciles without duplicate bubbles. */
import assert from "node:assert/strict";
import test from "node:test";
import { boot, sleep } from "../helpers/jsdom-app.mjs";

const TEXTO = "cambia de rumbo";
const row = (id) => ({ id, title: `Tarea ${id}`, last_message: "", provider: "claude", model: "opus", refs: [], updated_at: 0, turns: 1, parent: null, esperando: false });
const session = (id, turns) => ({ id, provider: "claude", sources: [], model: "opus", effort: null, permission_mode: null, turns });

function responses(overrides) {
  return {
    window_ready: null,
    window_vitals: null,
    setup_required: false,
    service_poll: { cursor: 0, gap: false, replay: false, runtime: "lab", reset: false },
    list_providers: [{ id: "claude", label: "Claude", available: true, driver: true }],
    list_workspaces: { workspaces: [{ id: "w", name: "W", context_root: null }], active: "w" },
    workspaces_startup: { workspaces: [{ id: "w", name: "W", context_root: null }], active: "w" },
    list_projects: () => [{ id: "p1", name: "P1", working_directory: "/lab/p1", kind: "git", portfolio: null, sources: [] }],
    list_portfolios: [],
    list_sources: [],
    list_live_sessions: ({ project }) => (project === "" || project === "p1" ? [row("t1"), row("t2")] : []),
    list_agents: { agents: [], rechazados: [] },
    list_agent_status: [],
    list_mentions: { fuentes: [], archivos: [] },
    list_models: { provider: "claude", models: [{ id: "opus", label: "Opus", gratis: null, note: null, efforts: [], default_effort: null }], fallback: false },
    list_surfaces: [{ id: "claude", provider: "claude", label: "Claude", catalogo: "todo", usable: true, marca: null, porque: null }],
    session_folder: "/tmp",
    list_task_trees: [],
    watch_task_tree: "watch",
    unwatch_task_tree: null,
    task_history: { history: { archived: false, events: [], recovery: null }, branch: null, path: "/lab", available: true, owned: false, restorable: false, recreatable: false, incomplete: false },
    list_live_turns: [],
    list_active_turns: [],
    load_queue: [],
    save_queue: null,
    session_usage: null,
    list_session_git: {},
    ...overrides,
  };
}

async function abrir(app, id) {
  const el = app.w.document.querySelector(`[data-sesion="${id}"]`);
  assert.ok(el, `no está la fila de ${id}`);
  el.click();
  await sleep(400);
}

const veces = (app) => app.w.document.body.textContent.split(TEXTO).length - 1;

for (const legacy of [false, true]) {
  test(`automatic background delivery${legacy ? " on a legacy engine" : ""}: one injection and one bubble`, async () => {
    const injected = [];
    let disco = [{ role: "user", id: "u0", at: 0, text: "hola" }];
    const app = await boot("listo", `chat-steer-once-background-${legacy}`, responses({
      load_session: ({ id }) => session(id, id === "t1" ? disco : [{ role: "user", id: "x0", at: 0, text: "otra" }]),
      inject_message: async (args) => {
        injected.push(args);
        const turn = { role: "user", id: `i${injected.length}`, at: 1, text: args.prompt };
        disco = [...disco, turn];
        await sleep(150);
        return legacy ? null : turn;
      },
    }));
    try {
      await sleep(600);
      await abrir(app, "t1");
      app.emit("chat", { kind: "started", session: "t1", workspace: "w" });
      await sleep(200);
      const field = app.w.document.querySelector("textarea");
      assert.ok(field);
      field.value = TEXTO;
      field.dispatchEvent(new app.w.Event("input", { bubbles: true }));
      await sleep(50);
      const enter = () => field.dispatchEvent(new app.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      enter();
      await sleep(20);
      app.emit("chat", { kind: "background", session: "t1", workspace: "w" });
      app.emit("chat", { kind: "background", session: "t1", workspace: "w" });
      await sleep(500);
      assert.equal(injected.length, 1, "se metió más de una vez");
      assert.equal(veces(app), 1, "el globo no salió una vez");
      // Releer la tarea con el turno corriendo trae del disco lo metido.
      await abrir(app, "t2");
      await abrir(app, "t1");
      await sleep(300);
      assert.equal(veces(app), 1, "releer la tarea repitió lo metido");
    } finally {
      app.w.close();
    }
  });
}
