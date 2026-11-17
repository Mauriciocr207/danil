/**
 * El selector de la tarea nueva abre con los 8 proyectos más recientes y pliega
 * el resto en «Más proyectos… (N)»; con texto busca en todo y sin corte, y lo
 * desplegado se pliega al cerrar. Monta `dist/` con el IPC simulado.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { boot, sleep } from "../helpers/jsdom-app.mjs";

const DAY = 86_400_000;
const NOW = Date.now();
const PROJECTS = [
  ...Array.from({ length: 30 }, (_, i) => ({ id: `old${i}`, name: `Viejo ${String(i).padStart(2, "0")}`, created_at: Math.floor((NOW - (400 - i) * DAY) / 1000) })),
  { id: "danil-app", name: "Danil App", created_at: Math.floor((NOW - 500 * DAY) / 1000) },
].map((p) => ({ ...p, updated_at: p.created_at, node: null, working_directory: `/lab/${p.id}`, kind: "git", portfolio: null, sources: [], sessions: p.id === "danil-app" ? 1 : 0 }));
const task = { id: "t1", title: "Tarea", last_message: "", provider: "claude", model: "opus", refs: [], created_at: NOW - DAY, updated_at: NOW - 60_000, last_turn_at: NOW - 60_000, turns: 1, parent: null, esperando: false };

const responses = {
  window_ready: null,
  window_vitals: null,
  setup_required: false,
  service_poll: { cursor: 0, gap: false, replay: false, runtime: "lab", reset: false },
  list_providers: [{ id: "claude", label: "Claude", available: true, driver: true }],
  list_workspaces: { workspaces: [{ id: "w", name: "W", context_root: null }], active: "w" },
  workspaces_startup: { workspaces: [{ id: "w", name: "W", context_root: null }], active: "w" },
  list_projects: () => PROJECTS,
  list_portfolios: [],
  list_sources: [],
  list_live_sessions: ({ project }) => (project === "danil-app" ? [task] : []),
  list_agents: { agents: [], rechazados: [] },
  list_agent_status: [],
  list_mentions: { fuentes: [], archivos: [] },
  list_models: { provider: "claude", models: [{ id: "opus", label: "Opus", gratis: null, note: null, efforts: [], default_effort: null }], fallback: false },
  list_surfaces: [{ id: "claude", provider: "claude", label: "Claude", catalogo: "todo", usable: true, marca: null, porque: null }],
  session_folder: "/tmp",
  list_task_trees: [],
  watch_task_tree: "watch",
  unwatch_task_tree: null,
  list_live_turns: [],
  list_active_turns: [],
  load_queue: [],
  save_queue: null,
  session_usage: null,
  list_session_git: {},
};

async function until(check, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (check()) return true;
  return check();
}

test("31 projects with tasks only in «Danil App»: it is among the 8 rows, the last is «Más proyectos… (23)», search has no cut and closing folds again", async () => {
  const app = await boot("listo", "project-picker-recent", responses);
  const doc = app.w.document;
  const search = () => doc.querySelector('input[placeholder="Buscar proyecto"]');
  const trigger = () => doc.querySelector('[aria-label="Proyecto"]');
  const list = () => search()?.closest("[role=dialog]")?.querySelector(".overflow-y-auto");
  const rows = () => [...(list()?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim());
  const more = () => list()?.querySelector("[data-more-projects]");
  try {
    assert.ok(await until(() => trigger()), "the project picker is on the new task");
    // Las tareas del riel tienen que haber llegado antes de abrir.
    assert.ok(await until(() => doc.querySelector('[data-sesion="t1"]')), "the task of «Danil App» is loaded");
    trigger().click();
    assert.ok(await until(() => more()), "«Más proyectos…» is offered");

    const closed = rows();
    assert.equal(closed.length, 1 + 8 + 1, `«Sin proyecto», 8 projects and «Más proyectos…»: ${closed.join(" | ")}`);
    assert.equal(closed[0], "Sin proyecto");
    assert.match(closed[1], /^Danil App/);
    assert.equal(closed.at(-1), "Más proyectos… (23)");

    more().click();
    assert.ok(await until(() => rows().length === 1 + 31), "the rest unfolds in the same list");
    assert.equal(more(), null);

    const field = search();
    field.value = "viejo";
    field.dispatchEvent(new app.w.Event("input", { bubbles: true }));
    assert.ok(await until(() => rows().length === 30), "the search shows every match, without a cut");
    assert.equal(more(), null, "no «Más proyectos…» while searching");
    assert.match(rows()[0], /^Viejo 29/, "matches in recent order");
    field.value = "";
    field.dispatchEvent(new app.w.Event("input", { bubbles: true }));

    doc.dispatchEvent(new app.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.ok(await until(() => !search()), "the popover closes");
    trigger().click();
    assert.ok(await until(() => more()), "reopened, the rest is folded again");
    assert.equal(rows().length, 1 + 8 + 1);
    assert.deepEqual(app.failures, []);
  } finally {
    app.w.close();
  }
});
