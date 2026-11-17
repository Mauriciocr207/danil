import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { inspectFront, regressions } from "../../scripts/front-modularization.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "front-modularization-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  put("tsconfig.json", JSON.stringify({ compilerOptions: { jsx: "preserve", module: "ESNext" } }));
  put("src/features/alpha/index.ts", 'export { value } from "./lib/value";\n');
  put("src/features/alpha/lib/value.ts", "export const value = 1;\n");
  put("src/features/beta/index.ts", 'export { value } from "../alpha/index";\n');
  put("src/app/App.tsx", 'export { value } from "../features/alpha/index";\n');
  return { root, put };
}

test("front ratchet rejects each regression and passes after removing it", async (t) => {
  const { root, put } = fixture(t);
  const baseline = await inspectFront(root);
  assert.deepEqual(baseline.dependencies, {});
  assert.deepEqual(baseline.solid, {});
  assert.deepEqual(regressions(baseline, baseline), []);
  const cases = [
    ["private import", "src/app/App.tsx", 'export { value } from "../features/alpha/lib/value";\n', "dependencies: app-feature-interface"],
    ["cross-feature private import", "src/features/beta/index.ts", 'export { value } from "../alpha/lib/value";\n', "dependencies: feature-interface"],
    ["unresolved import", "src/app/App.tsx", 'export { value } from "../missing";\n', "dependencies: no-unresolved"],
    ["cycle", "src/features/alpha/lib/value.ts", 'export { value } from "../index";\n', "dependencies: no-circular"],
    ["reactivity", "src/features/alpha/Counter.tsx", 'import { createSignal } from "solid-js";\nexport function Counter() { const [n] = createSignal(0); const value = n(); return <div>{value}</div>; }\n', "solid"],
    ["existing file growth", "src/app/App.tsx", "export const value = 1;\n\n", "lines"],
    ["new oversized file", "src/large.ts", `${"\n".repeat(399)}export {};\n`, "lines"],
    ["effect", "src/app/App.tsx", 'import { createEffect } from "solid-js"; createEffect(() => {});\n', "effects"],
    ["event", "src/app/App.tsx", 'window.dispatchEvent(new CustomEvent("harness:new"));\n', "events"],
  ];
  for (const [name, path, source, category] of cases) {
    await t.test(name, async () => {
      const saved = path === "src/app/App.tsx" ? 'export { value } from "../features/alpha/index";\n'
        : path === "src/features/beta/index.ts" ? 'export { value } from "../alpha/index";\n'
        : path === "src/features/alpha/lib/value.ts" ? "export const value = 1;\n" : null;
      put(path, source);
      assert.ok(regressions(await inspectFront(root), baseline).some((failure) => failure.startsWith(category)), name);
      if (saved === null) rmSync(join(root, path)); else put(path, saved);
      assert.deepEqual(regressions(await inspectFront(root), baseline), []);
    });
  }
});

test("removing one debt cannot pay for adding another", () => {
  const empty = { dependencies: {}, solid: {}, lines: {}, effects: {}, events: {} };
  const old = { ...empty, dependencies: { "old edge": 1 }, solid: { "old.ts:solid/reactivity": 1 } };
  const next = { ...empty, dependencies: { "new edge": 1 }, solid: { "new.ts:solid/reactivity": 1 } };
  assert.equal(regressions(next, old).length, 2);
});
