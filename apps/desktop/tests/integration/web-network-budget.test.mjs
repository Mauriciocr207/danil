import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate as immediate } from "node:timers/promises";
import test from "node:test";
import { boot } from "../helpers/jsdom-app.mjs";
import { relay } from "../helpers/fake-relay.mjs";

const origin = new URL(process.env.DANIL_WEB_API_ORIGIN).origin;
const baseline = JSON.parse(readFileSync(new URL("./web-network-budget-baseline.json", import.meta.url), "utf8"));
const realNow = Date.now.bind(Date);
const increment = (counts, name) => { counts[name] = (counts[name] ?? 0) + 1; };

function exceeded(actual, limit, prefix = "") {
  return Object.entries(actual).flatMap(([key, value]) => {
    const name = `${prefix}${key}`;
    return typeof value === "object"
      ? exceeded(value, limit?.[key], `${name}.`)
      : value > (limit?.[key] ?? 0) ? [`${name}: ${value} > ${limit?.[key] ?? 0}`] : [];
  });
}

test("real web startup and sixty seconds idle stay within the network budget", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date("2026-11-13T18:00:00Z") });
  const counts = { http: {}, rpc: {}, sockets: 0, httpRequestPayloadBytes: 0, httpResponsePayloadBytes: 0, wsSentPayloadBytes: 0, wsReceivedPayloadBytes: 0 };
  const snapshot = () => structuredClone(counts);
  const milestones = {};
  const fake = relay();
  let browser;
  let observer;
  t.after(() => {
    observer?.disconnect();
    browser?.dispatchEvent(new browser.Event("pagehide"));
    browser?.close();
    t.mock.timers.reset();
  });
  class Socket extends fake.Socket {
    constructor(...args) {
      super(...args);
      counts.sockets += 1;
      for (const name of ["onopen", "onmessage"]) {
        let listener;
        Object.defineProperty(this, name, {
          configurable: true,
          get: () => listener,
          set: (next) => { listener = (event) => {
            if (name === "onopen") milestones.connected ??= snapshot();
            if (name === "onmessage") {
              counts.wsReceivedPayloadBytes += Buffer.byteLength(event.data);
              const reply = JSON.parse(event.data);
              if (reply.type === "result" && !reply.error) milestones.result ??= snapshot();
            }
            return next?.(event);
          }; },
        });
      }
    }
    send(data) {
      const message = JSON.parse(data);
      counts.wsSentPayloadBytes += Buffer.byteLength(data);
      if (message.type === "call") increment(counts.rpc, message.command);
      return super.send(data);
    }
  }
  // Simulated DTOs from window-page.test.mjs; this budget is not contract conformance.
  const routes = {
    "/v1/capabilities": { contract: "mvp-v1", items: ["machines", "machines.start", "machines.session", "workspaces", "identity.organizations"].map(name => ({ name, version: 1, status: "available" })) },
    "/v1/identity/me": { id: "user_A", name: "Operator", workspace: "11", organizations: [] },
    "/v1/identity/csrf": { csrf_token: "bound" },
    "/v1/identity/organizations": { items: [{ id: "org_A", name: "Danil", plan: "enterprise", role: "owner" }], next_cursor: null, active_organization_id: "org_A" },
    "/v1/workspaces": { items: [{ id: "11", org: "org_A", name: "Alpha", role: "owner" }], next_cursor: null },
    "/v1/machines": { items: [{ machine_id: "m1", name: "Danil", state: "running", connection: "connected" }], next_cursor: null },
  };
  const request = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.origin === "http://localhost" && url.pathname.includes("/assets/")) return new Response("");
    assert.equal(url.origin, origin);
    assert.equal(init.credentials, "include");
    assert.equal(new Headers(init.headers).has("authorization"), false);
    increment(counts.http, `${init.method ?? "GET"} ${url.pathname}`);
    counts.httpRequestPayloadBytes += Buffer.byteLength(init.body ?? "");
    let response;
    if (url.pathname.endsWith("/tickets")) {
      response = Response.json({ ticket: "one-use", url: "wss://connect.danil.ai/v1/machines/m1/session",
        expires_at: new Date(Date.now() + 30_000).toISOString(),
        session_expires_at: new Date(Date.now() + 60_000).toISOString(), protocol: "danil.machine-session.v1" }, { status: 201 });
    } else {
      assert.ok(routes[url.pathname], `Unexpected edge request: ${url.pathname}`);
      response = Response.json(routes[url.pathname]);
    }
    counts.httpResponsePayloadBytes += (await response.clone().arrayBuffer()).byteLength;
    return response;
  };
  request.__jsdomApp = true;
  globalThis.fetch = request;
  const mounting = boot("listo", "network-budget", {}, undefined, {}, { web: true, beforeImport(w) {
    browser = w;
    w.WebSocket = Socket;
    globalThis.WebSocket = Socket;
    observer = new w.MutationObserver(() => {
      if (w.document.querySelector("[data-tira]")) milestones.paint ??= snapshot();
    });
    observer.observe(w.document, { childList: true, subtree: true });
  } });
  async function drain() {
    t.mock.timers.tick(0);
    for (let i = 0; i < 8; i++) await immediate();
  }
  async function until(read) {
    const deadline = realNow() + 15_000;
    while (!read()) {
      assert.ok(realNow() < deadline, "Web startup did not reach its observable milestone");
      await drain();
    }
  }
  await until(() => (counts.http["GET /v1/workspaces"] ?? 0) >= 1);
  await drain();
  t.mock.timers.tick(1000);
  await until(() => milestones.paint && milestones.result);
  await drain();
  const app = await mounting;
  assert.deepEqual(app.failures, []);
  assert.ok(milestones.connected, "Socket upgrade is distinct from the first engine result");
  const startup = snapshot();
  for (let ms = 0; ms < 60_000; ms += 100) {
    t.mock.timers.tick(100);
    await drain();
  }
  if (process.env.DANIL_NETWORK_BUDGET_INJECT === "1") await request(`${origin}/v1/capabilities`, { credentials: "include" });
  const idle = snapshot();
  for (const group of ["http", "rpc"]) {
    for (const key of Object.keys(idle[group])) idle[group][key] -= startup[group][key] ?? 0;
  }
  for (const key of ["sockets", "httpRequestPayloadBytes", "httpResponsePayloadBytes", "wsSentPayloadBytes", "wsReceivedPayloadBytes"]) idle[key] -= startup[key];
  assert.deepEqual(app.failures, []);
  t.diagnostic(JSON.stringify({ startup, idle, milestones }));
  assert.deepEqual(exceeded(startup, baseline.startup), []);
  assert.deepEqual(exceeded(idle, baseline.idle), []);
});
