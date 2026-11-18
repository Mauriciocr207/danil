import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const base = `/${(process.env.TERMINUS_WEB_BASE ?? "/terminus/").replace(/^\/+|\/+$/g, "")}/`.replace("//", "/");
const output = new URL(`../../dist-web${base}`, import.meta.url);

test("the published page leaves the real window preload inert until desktop routing", () => {
  const html = readFileSync(new URL("index.html", output), "utf8");
  const page = new JSDOM(html, { url: new URL(base, "https://beta.danil.ai").href });
  try {
    const assets = new URL("assets/", output);
    const entries = readdirSync(assets).filter(name => /^main-.*\.js$/.test(name));
    const app = entries.filter(name => readFileSync(new URL(name, assets), "utf8").includes('"window_background"'));
    assert.equal(app.length, 1, "the window entry is distinguished from the web bootstrap by its background IPC");
    const expected = `${base}assets/${app[0]}`;
    assert.ok(![...page.window.document.querySelectorAll('link[rel="modulepreload"]')].some(link => link.getAttribute("href") === expected), "the initial HTML cannot start the app download before routing");
    const links = [...page.window.document.querySelectorAll("link[data-app-preload]")];
    assert.equal(links.length, 1, "the desktop route receives exactly one app preload candidate");
    assert.equal(links[0].getAttribute("href"), expected);
    assert.equal(links[0].hasAttribute("rel"), false, "phone routing must run before the browser fetches the desktop app");
    const path = new URL(expected.slice(base.length), output);
    assert.ok(readFileSync(fileURLToPath(path)).byteLength > 0, "the preloaded asset exists in this build");
    assert.ok(![...page.window.document.scripts].some(script => script.getAttribute("src") === expected), "the app is fetched as a modulepreload, never an early module script");
  } finally {
    page.window.close();
  }
});
