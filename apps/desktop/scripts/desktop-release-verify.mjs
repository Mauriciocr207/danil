// La compuerta de una publicación manual: abre el instalador, AppImage o .app ya
// construido y exige las herramientas con su inventario, como publish.yml tras empaquetar.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const TARGETS = {
  win32: ["x86_64-pc-windows-msvc"],
  linux: ["x86_64-unknown-linux-gnu"],
  darwin: ["aarch64-apple-darwin", "x86_64-apple-darwin"],
};

/** Qué plataforma es el artefacto y dónde quedan sus herramientas una vez abierto. */
export function artifactPlan(artifact, host = process.platform) {
  const name = basename(artifact.replace(/[\\/]+$/, ""));
  const platform = name.endsWith(".AppImage") ? "linux" : name.endsWith(".exe") ? "win32" : /\.(app|dmg)$/.test(name) ? "darwin" : null;
  if (!platform) throw new Error(`no sé abrir ${name}: pasa el *_x64-setup.exe, el *.AppImage, el Danil.app o el .dmg`);
  if (platform !== host) {
    throw new Error(`${name} se verifica en ${platform}: su motor tiene que correr y el inventario se lee con las reglas de esa plataforma`);
  }
  const layout = {
    linux: { resources: "squashfs-root/usr/share/Danil/work-tools", engine: "squashfs-root/usr/bin/seldon-runtime" },
    win32: { resources: "work-tools", engine: "seldon-runtime.exe" },
    darwin: { resources: "Contents/Resources/work-tools", engine: "Contents/MacOS/seldon-runtime" },
  }[platform];
  return { platform, targets: TARGETS[platform], ...layout };
}

/** Cada árbol que el paquete tiene que traer, con un manifiesto de esta generación. */
export function checkManifests(resources, targets) {
  const problems = [];
  for (const target of targets) {
    const path = join(resources, target, "manifest.json");
    if (!existsSync(path)) {
      problems.push(`falta ${target}/manifest.json: el paquete no trae work-tools/${target}`);
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      problems.push(`${target}/manifest.json no se lee: ${error.message}`);
      continue;
    }
    if (manifest.schema !== 2 || manifest.layout !== "tree" || manifest.target !== target) {
      problems.push(`${target}/manifest.json no es un árbol de esquema 2 para ${target} (schema ${manifest.schema}, layout ${manifest.layout}, target ${manifest.target})`);
    }
  }
  return problems;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${basename(command)} ${args[0] ?? ""} salió con ${result.status}`);
}

function sevenZip() {
  const names = ["7z.exe", "7zz.exe", "7za.exe", "7z", "7zz", "7za"];
  const dirs = (process.env.PATH ?? "").split(delimiter).concat(process.env.ProgramFiles ? [join(process.env.ProgramFiles, "7-Zip")] : []);
  for (const dir of dirs) for (const name of names) if (dir && existsSync(join(dir, name))) return join(dir, name);
  throw new Error("hace falta 7-Zip (7z) para abrir el instalador de NSIS");
}

/** Abre el artefacto en `scratch` y devuelve la carpeta donde queda el `layout`, y cómo cerrarlo. */
function open(artifact, plan, scratch) {
  if (plan.platform === "linux") {
    run(artifact, ["--appimage-extract"], { cwd: scratch, stdio: ["ignore", "ignore", "inherit"] });
    return { base: scratch, close() {} };
  }
  if (plan.platform === "win32") {
    run(sevenZip(), ["x", "-y", `-o${scratch}`, artifact], { stdio: ["ignore", "ignore", "inherit"] });
    return { base: scratch, close() {} };
  }
  if (statSync(artifact).isDirectory()) return { base: artifact, close() {} };
  const mount = join(scratch, "dmg");
  run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, artifact]);
  return { base: join(mount, "Danil.app"), close: () => spawnSync("hdiutil", ["detach", mount, "-force"]) };
}

export function verify(artifact) {
  const plan = artifactPlan(artifact);
  if (plan.platform === "darwin" && !process.env.APPLE_TEAM_ID) {
    throw new Error("APPLE_TEAM_ID hace falta: el árbol de macOS se verifica con su firma (work-tools-macos.py)");
  }
  const scratch = mkdtempSync(join(tmpdir(), "danil-release-verify-"));
  let opened;
  try {
    opened = open(artifact, plan, scratch);
    const resources = join(opened.base, plan.resources);
    const problems = checkManifests(resources, plan.targets);
    if (problems.length) throw new Error(problems.join("; "));
    const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
    run(python, [join(ROOT, "scripts/work-tools-release.py"), "verify", "--directory", resources]);
    const app = plan.platform === "darwin" ? ["--app", opened.base] : [];
    run(python, [join(ROOT, "scripts/work-tools-runtime-smoke.py"), "--engine", join(opened.base, plan.engine), "--resources", dirname(resources), "--browser", "--clone", ...app]);
    return { artifact, platform: plan.platform, targets: plan.targets };
  } finally {
    opened?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const artifact = process.argv[2];
  if (!artifact) {
    console.error("Uso: node scripts/desktop-release-verify.mjs <*_x64-setup.exe | *.AppImage | Danil.app | *.dmg>");
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(verify(resolve(artifact)), null, 2));
    console.log("Artefacto verificado: lleva las herramientas incluidas íntegras y el motor las usa.");
  } catch (error) {
    console.error(`desktop-release-verify: NO se publica. ${error.message}`);
    process.exit(1);
  }
}
