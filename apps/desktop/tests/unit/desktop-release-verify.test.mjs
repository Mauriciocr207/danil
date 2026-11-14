// La compuerta de una publicación manual rechaza un artefacto sin herramientas, como la 0.3.2.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { artifactPlan, checkManifests, TARGETS } from "../../scripts/desktop-release-verify.mjs";

const root = resolve(fileURLToPath(import.meta.url), "../../..");

function tree(manifests) {
  const dir = mkdtempSync(join(tmpdir(), "danil-release-gate-"));
  for (const [target, manifest] of Object.entries(manifests)) {
    mkdirSync(join(dir, target), { recursive: true });
    writeFileSync(join(dir, target, "manifest.json"), JSON.stringify(manifest));
  }
  return dir;
}

const good = (target) => ({ schema: 2, layout: "tree", target });

test("each artifact opens on its own platform and names where its tools live", () => {
  assert.deepEqual(artifactPlan("/x/Danil_0.3.3_x64-setup.exe", "win32"), {
    platform: "win32", targets: ["x86_64-pc-windows-msvc"], resources: "work-tools", engine: "seldon-runtime.exe",
  });
  assert.equal(artifactPlan("/x/Danil_0.3.3_amd64.AppImage", "linux").resources, "squashfs-root/usr/share/Danil/work-tools");
  assert.deepEqual(artifactPlan("/x/Danil.app/", "darwin").targets, TARGETS.darwin);
  assert.equal(artifactPlan("/x/Danil_0.3.3_universal.dmg", "darwin").platform, "darwin");
  assert.throws(() => artifactPlan("/x/Danil_0.3.3_x64-setup.exe", "linux"), /win32/);
  assert.throws(() => artifactPlan("/x/Danil.zip", "linux"), /no sé abrir/);
});

test("a package without its tree, or with another generation's manifest, does not pass", () => {
  const empty = tree({});
  const old = tree({ "x86_64-pc-windows-msvc": { schema: 1, layout: "tree", target: "x86_64-pc-windows-msvc" } });
  const wrong = tree({ "x86_64-pc-windows-msvc": good("aarch64-pc-windows-msvc") });
  const ok = tree({ "x86_64-pc-windows-msvc": good("x86_64-pc-windows-msvc") });
  try {
    assert.match(checkManifests(empty, TARGETS.win32).join(), /no trae work-tools\/x86_64-pc-windows-msvc/);
    assert.match(checkManifests(old, TARGETS.win32).join(), /esquema 2/);
    assert.match(checkManifests(wrong, TARGETS.win32).join(), /esquema 2/);
    assert.deepEqual(checkManifests(ok, TARGETS.win32), []);
  } finally {
    for (const dir of [empty, old, wrong, ok]) rmSync(dir, { recursive: true, force: true });
  }
});

test("the universal macOS app needs both architectures", () => {
  const one = tree({ "aarch64-apple-darwin": good("aarch64-apple-darwin") });
  const both = tree({ "aarch64-apple-darwin": good("aarch64-apple-darwin"), "x86_64-apple-darwin": good("x86_64-apple-darwin") });
  try {
    assert.match(checkManifests(one, TARGETS.darwin).join(), /x86_64-apple-darwin/);
    assert.deepEqual(checkManifests(both, TARGETS.darwin), []);
  } finally {
    for (const dir of [one, both]) rmSync(dir, { recursive: true, force: true });
  }
});

test("an AppImage like 0.3.2, with engine and no tools, is refused", { skip: process.platform !== "linux" && "an AppImage is verified on Linux" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "danil-release-gate-"));
  try {
    const image = join(dir, "Danil_0.3.2_amd64.AppImage");
    writeFileSync(image, "#!/bin/sh\nmkdir -p squashfs-root/usr/bin squashfs-root/usr/share/Danil/lenguas\ntouch squashfs-root/usr/bin/seldon-runtime\n");
    chmodSync(image, 0o755);
    const run = spawnSync(process.execPath, [join(root, "scripts/desktop-release-verify.mjs"), image], { encoding: "utf8" });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stderr, /NO se publica.*no trae work-tools\/x86_64-unknown-linux-gnu/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
