import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import * as modularization from "../../scripts/front-modularization.mjs";
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

test("public interface classification permits only explicit named reexports", () => {
  const classify = (text, path = "src/features/alpha/index.ts") =>
    modularization.publicInterfaceCode(path, ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true));
  for (const text of [
    'export { value } from "./value";',
    'export { default as View } from "./View";\nexport type { Props } from "./types";',
    'export { type Props, value as renamed } from "./value";',
  ]) assert.equal(classify(text), 0, text);
  for (const text of [
    '', '// empty facade', 'export {};', 'export {} from "./value";',
    'export * from "./value";', 'export * as values from "./value";',
    'import { value } from "./value"; export { value };',
    'import type { Props } from "./types"; export type { Props };',
    'export const value = 1;', 'export function value() {}', 'export class Value {}',
    'export interface Props {}', 'console.log("side effect");', 'await load();',
    'export { value from "./value";',
  ]) assert.equal(classify(text), 1, text);
  assert.equal(classify('export { value } from "./value";', "src/features/alpha/index.tsx"), 0);
  for (const path of ["src/app/App.tsx", "src/index.ts", "src/features/alpha/lib/index.ts", "src/features/alpha/store.ts"]) {
    assert.equal(classify('export const value = 1;', path), null, path);
  }
});

test("public interface line cap is fixed while executable entries always fail", () => {
  const path = "src/features/alpha/index.ts";
  const baseline = { lines: { [path]: 1 } };
  const facade = lines => ({ lines: { [path]: lines }, interfaceCode: { [path]: 0 } });
  assert.deepEqual(regressions(facade(2), baseline), []);
  assert.deepEqual(regressions(facade(399), baseline), []);
  assert.ok(regressions(facade(400), baseline).some(failure => failure.startsWith("lines:")));
  assert.ok(regressions(facade(400), { lines: { [path]: 500 } }).some(failure => failure.startsWith("lines:")));
  const executable = { lines: { [path]: 1 }, interfaceCode: { [path]: 1 } };
  assert.ok(regressions(executable, baseline).some(failure => failure.startsWith("interfaceCode:")));
  assert.ok(regressions(executable, { ...baseline, interfaceCode: { [path]: 1 } }).some(failure => failure.startsWith("interfaceCode:")));
});

test("public interface grows through the actual inspection pipeline without a baseline change", async t => {
  const { root, put } = fixture(t);
  const path = "src/features/alpha/index.ts";
  const original = 'export { value } from "./lib/value";\n';
  const baseline = await inspectFront(root);
  put(path, original + 'export { value as renamed } from "./lib/value";\n');
  const grown = await inspectFront(root);
  assert.equal(grown.lines[path], 2, "physical line count remains truthful");
  assert.equal(grown.interfaceCode[path], 0);
  assert.deepEqual(regressions(grown, baseline), []);
  put(path, original + 'export const local = 1;\n');
  assert.ok(regressions(await inspectFront(root), baseline).some(failure => failure.startsWith("interfaceCode:")));
  put(path, original);
  assert.deepEqual(regressions(await inspectFront(root), baseline), []);
});
