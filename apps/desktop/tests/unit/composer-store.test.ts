import assert from "node:assert/strict";
import test from "node:test";
import { createRoot, createSignal } from "solid-js";
import { createComposerStore } from "../../src/features/composer/index.ts";
import type { AgentModels, ModelOption } from "../../src/lib/model.ts";
import type { Superficie } from "../../src/lib/surfaces.ts";

globalThis.window = new EventTarget() as unknown as Window & typeof globalThis;
const model = (id: string): ModelOption => ({ id, label: id, efforts: ["low", "high"], default_effort: "low", gratis: false, note: null });
const catalog = (provider: string, id: string): AgentModels => ({ provider, models: [model(id)], fallback: false });
const surface: Superficie = { id: "claude", provider: "claude", label: "Claude", catalogo: "todo", usable: true, marca: null, porque: null };
function pending<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(options: { invoke?: Parameters<typeof createComposerStore>[0]["invoke"]; install?: boolean; last?: Parameters<typeof createComposerStore>[0]["withLastAnswer"] } = {}) {
  return createRoot(dispose => {
    const [workspace, setWorkspace] = createSignal<string | null>("A");
    const [machine, setMachine] = createSignal<string | null>("m1");
    const [session, setSession] = createSignal<string | null>(null);
    const [workspaceMode, setWorkspaceMode] = createSignal<string | null>(null);
    const [configuration, setConfiguration] = createSignal<ReturnType<typeof createComposerStore>["snapshot"] extends () => infer C ? C | undefined : never>(undefined);
    const calls: { command: string; headers?: Record<string, string> }[] = [];
    const store = createComposerStore({
      invoke: async <T>(command: string, args?: Record<string, unknown>, routed?: { headers: Record<string, string> }) => {
        calls.push({ command, headers: routed?.headers });
        if (options.invoke) return options.invoke<T>(command, args, routed);
        const value = command === "list_models" ? catalog(String(args?.provider), "first") : command === "list_surfaces" ? [surface] : command === "list_slash_menu" ? { commands: [], skills: [] } : [];
        return value as T;
      },
      withLastAnswer: options.last ?? (async (_machine, _key, read) => read()),
      scope: { workspace, machine, machineOn: () => true, connected: () => false, session },
      workspaceMode, draftConfiguration: configuration,
    });
    if (options.install) store.installEffects();
    return { store, calls, setWorkspace, setMachine, setSession, setWorkspaceMode, setConfiguration, dispose: () => { store.dispose(); dispose(); } };
  });
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("concurrent catalog readers share one result and another provider cannot select its model", async () => {
  const result = pending<AgentModels>(); const f = fixture({ invoke: async <T>() => result.promise as Promise<T> });
  const one = f.store.readModels("codex"), two = f.store.readModels("codex");
  assert.equal(one, two); assert.equal(f.calls.length, 1);
  result.resolve(catalog("codex", "gpt")); await one;
  assert.equal(f.store.model(), ""); assert.equal(f.store.catalogos().codex?.models[0].id, "gpt"); f.dispose();
});

test("catalog route is captured before a delayed adapter runs", async () => {
  let run!: () => Promise<AgentModels>;
  const f = fixture({ last: <T>(_machine: string | null, _key: string, read: () => Promise<T>) => { run = read as () => Promise<AgentModels>; return new Promise<T>(() => {}); } });
  void f.store.readModels("claude"); f.setWorkspace("B"); f.setMachine("m2"); await run();
  assert.deepEqual(f.calls[0].headers, { "x-terminus-machine": "m1", "x-terminus-workspace": "A" }); f.dispose();
});

test("A to B to A discards an old catalog response", async () => {
  const old = pending<AgentModels>(); let reads = 0;
  const f = fixture({ install: true, invoke: async <T>(command: string) => {
    if (command === "list_models") return (++reads === 1 ? old.promise : Promise.resolve(catalog("claude", "new"))) as Promise<T>;
    return (command === "list_slash_menu" ? { commands: [], skills: [] } : []) as T;
  } });
  f.setWorkspace("B"); await tick(); f.setWorkspace("A"); await tick();
  await f.store.readModels("claude", true); old.resolve(catalog("claude", "old")); await tick();
  assert.equal(f.store.catalogos().claude?.models[0].id, "new"); f.dispose();
});

test("restoring a draft is atomic and manual permission mode beats workspace default", async () => {
  const f = fixture({ install: true }); await tick();
  const config = { agent: "claude", surface: "claude", model: "first", effort: "high", mode: "manual" };
  f.setConfiguration(config); f.store.restoreDraft(config); f.setWorkspaceMode("auto"); await tick();
  assert.equal(f.store.model(), "first"); assert.equal(f.store.effort(), "high"); assert.equal(f.store.modo(), "manual");
  f.setConfiguration(undefined); f.setWorkspaceMode("ediciones"); await tick(); assert.equal(f.store.modo(), "ediciones"); f.dispose();
});

test("existing legacy session cannot adopt a draft provider but absent session can", () => {
  const f = fixture(); const draft = { provider: { from: "claude", to: "codex" } };
  f.store.restoreSessionDraft(draft, { provider: "" }); assert.equal(f.store.agent(), "claude");
  f.store.restoreSessionDraft(draft); assert.equal(f.store.agent(), "codex"); f.dispose();
});

test("legacy session without permission mode clears the previous mode", () => {
  const f = fixture(); f.store.chooseMode("manual");
  f.store.runtimeFact({ kind: "mode", value: "" }); assert.equal(f.store.modo(), ""); f.dispose();
});

test("model selection uses surface and retains valid effort; profiles update only supplied preferences", () => {
  const f = fixture(); f.store.chooseEffort("high");
  f.store.selectModel({ key: "claude:chosen", superficie: "claude", agent: "claude", usable: true, proveedor: { id: "claude", label: "Claude", logo: "claude" }, model: model("chosen") });
  assert.deepEqual(f.store.snapshot(), { agent: "claude", surface: "claude", model: "chosen", effort: "high" });
  f.store.useProfile({ provider: "codex" }); assert.equal(f.store.model(), "chosen"); assert.equal(f.store.agent(), "codex"); f.dispose();
});

test("dispose blocks pending answers, new reads and scope-triggered reads", async () => {
  const result = pending<AgentModels>(); const f = fixture({ install: true, invoke: async <T>(command: string) => command === "list_models" ? result.promise as Promise<T> : (command === "list_slash_menu" ? { commands: [], skills: [] } : []) as T });
  await tick(); f.store.dispose(); const count = f.calls.length;
  f.setWorkspace("B"); f.store.refreshCommands("claude"); void f.store.refreshSurfaces(false); void f.store.refreshProviders();
  await f.store.readModels("codex"); result.resolve(catalog("claude", "late")); await tick();
  assert.equal(f.calls.length, count); assert.deepEqual(f.store.catalogos(), {}); f.dispose();
});
