// `tauri build` que no empaqueta sin `work-tools/`: la 0.3.2 de Windows y Linux salió sin ellas
// y, sin git en la máquina, la preparación pedía una reparación imposible.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ESCAPE = "DANIL_BUILD_WITHOUT_WORK_TOOLS";

/** Los valores de una opción de `tauri build`: `--name v`, `--name=v` o su forma corta. */
function values(args, long, short) {
  const found = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === long || (short && arg === short)) {
      if (i + 1 < args.length) found.push(args[++i]);
    } else if (arg.startsWith(`${long}=`)) {
      found.push(arg.slice(long.length + 1));
    }
  }
  return found;
}

/** La plataforma del paquete: la de `--target` o la de esta máquina. */
function platformOf(args, host) {
  const target = values(args, "--target", "-t").at(-1);
  if (!target) return host;
  if (target.includes("windows")) return "win32";
  if (target.includes("apple-darwin")) return "darwin";
  if (target.includes("linux")) return "linux";
  return host;
}

/** Un `--config` es JSON en línea o la ruta de un archivo JSON. */
function readConfig(value, cwd) {
  const text = value.trimStart().startsWith("{") ? value : readFileSync(resolve(cwd, value), "utf8");
  return JSON.parse(text);
}

/** Las carpetas de herramientas que un overlay pone en el paquete de esa plataforma. */
function trees(config, platform) {
  const bundle = config?.bundle ?? {};
  const entries = (map) => Object.entries(map && typeof map === "object" && !Array.isArray(map) ? map : {});
  if (platform === "win32") {
    return entries(bundle.resources)
      .filter(([, target]) => typeof target === "string" && target.replaceAll("\\", "/").startsWith("work-tools/"))
      .map(([source]) => source);
  }
  if (platform === "darwin") {
    return entries(bundle.macOS?.files)
      .filter(([target]) => target.startsWith("Resources/work-tools/"))
      .map(([, source]) => source);
  }
  return entries(bundle.linux?.appimage?.files)
    .filter(([target]) => /^\/?usr\/share\/[^/]+\/work-tools\//.test(target))
    .map(([, source]) => source);
}

/** Por qué este `tauri build` no puede empaquetar, o `null`; `--debug` y `--no-bundle` pasan. */
export function missingWorkTools(args, { platform = process.platform, env = process.env, cwd = ROOT } = {}) {
  if (args.includes("--debug") || args.includes("-d") || args.includes("--no-bundle")) return null;
  if (env[ESCAPE] === "1") return null;
  const target = platformOf(args, platform);
  const configs = values(args, "--config", "-c");
  let sources = [];
  for (const value of configs) {
    let config;
    try {
      config = readConfig(value, cwd);
    } catch (error) {
      return `no se pudo leer --config ${value}: ${error.message}`;
    }
    sources = sources.concat(trees(config, target));
  }
  if (!sources.length) {
    return "ningún --config pone work-tools/ en el paquete. Prepáralo con `python3 scripts/work-tools-release.py prepare --directory <dir>` y pasa `--config <dir>/tauri.work-tools.json`.";
  }
  const tauriDir = join(cwd, "src-tauri");
  const empty = sources.filter((source) => !existsSync(join(isAbsolute(source) ? source : resolve(tauriDir, source), "manifest.json")));
  if (empty.length) return `el overlay apunta a carpetas sin manifest.json: ${empty.join(", ")}`;
  return null;
}

function tauri(args) {
  const require = createRequire(join(ROOT, "package.json"));
  const manifest = require.resolve("@tauri-apps/cli/package.json");
  const { bin } = JSON.parse(readFileSync(manifest, "utf8"));
  const entry = join(dirname(manifest), typeof bin === "string" ? bin : bin.tauri);
  // El `.js` con este node: en Windows `tauri.cmd` pasaría el JSON de `--config` por cmd.exe.
  return spawnSync(process.execPath, [entry, "build", ...args], { cwd: ROOT, stdio: "inherit" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const reason = missingWorkTools(args);
  if (reason) {
    console.error(`desktop:build: un paquete de Danil sin herramientas incluidas no arranca bien en una máquina sin git: ${reason}`);
    console.error(`Para un build de desarrollo que no se publica: ${ESCAPE}=1 pnpm desktop:build …`);
    process.exit(1);
  }
  if (process.env[ESCAPE] === "1") console.warn(`desktop:build: ${ESCAPE}=1; este paquete no lleva herramientas y no se publica.`);
  const result = tauri(args);
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
