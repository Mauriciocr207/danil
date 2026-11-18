import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectFront, regressions } from "../front-modularization.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const baselinePath = join(root, "scripts/guards/front-modularization-baseline.json");
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const current = await inspectFront(root);
const failures = regressions(current, baseline);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else if (process.argv.includes("--update")) {
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
  console.log("Front modularization baseline lowered.");
} else {
  console.log("Front modularization: no new private imports, cycles, Solid findings, file growth, effects or data events.");
}
