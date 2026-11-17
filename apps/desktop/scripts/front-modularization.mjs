import { readFileSync } from "node:fs";
import { relative, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import ts from "typescript";
import solidConfig from "../eslint.solid.config.mjs";
import { walkFiles } from "./git.mjs";

const slash = (path) => path.replaceAll("\\", "/");
const increment = (map, key) => { map[key] = (map[key] ?? 0) + 1; };

export async function inspectFront(root) {
  const current = { dependencies: {}, solid: {}, lines: {}, effects: {}, events: {} };
  const cli = fileURLToPath(new URL("../../bin/dependency-cruiser.mjs", import.meta.resolve("dependency-cruiser")));
  const config = fileURLToPath(new URL("../dependency-cruiser.config.cjs", import.meta.url));
  let output;
  try {
    output = execFileSync(process.execPath, [cli, "src", "--config", config, "--output-type", "json"], {
      cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (error.status !== 1 || !error.stdout) throw error;
    output = error.stdout;
  }
  const graph = JSON.parse(output);
  for (const violation of graph.summary.violations) {
    const cycle = violation.cycle?.map((entry) => entry.name ?? entry).join(" -> ") ?? "";
    increment(current.dependencies, `${violation.rule.name}: ${violation.from} -> ${violation.to}${cycle ? ` [${cycle}]` : ""}`);
  }
  const eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: solidConfig, allowInlineConfig: false });
  const sources = [...walkFiles(join(root, "src"))].filter((path) => /\.[cm]?[jt]sx?$/.test(path));
  for (const result of await eslint.lintFiles(sources)) {
    for (const message of result.messages) {
      if (message.fatal || !message.ruleId) throw new Error(`${result.filePath}:${message.line}: ${message.message}`);
      increment(current.solid, `${slash(relative(root, result.filePath))}:${message.ruleId}`);
    }
  }
  for (const file of sources) {
    const path = slash(relative(root, file));
    const text = readFileSync(file, "utf8");
    current.lines[path] = text.split("\n").length - Number(text.endsWith("\n"));
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (path === "src/app/App.tsx" && ts.isCallExpression(node) && node.expression.getText(source) === "createEffect") increment(current.effects, path);
      if (ts.isNewExpression(node) && node.expression.getText(source) === "CustomEvent") {
        const name = node.arguments?.[0];
        if (name && ts.isStringLiteralLike(name) && name.text.startsWith("harness:")) increment(current.events, `${path}:${name.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return current;
}

export function regressions(current, baseline) {
  const failures = [];
  for (const category of Object.keys(current)) {
    for (const [key, value] of Object.entries(current[category])) {
      const limit = baseline[category]?.[key] ?? (category === "lines" ? 399 : 0);
      if (value > limit) failures.push(`${category}: ${key}: ${value} > ${limit}`);
    }
  }
  return failures;
}
