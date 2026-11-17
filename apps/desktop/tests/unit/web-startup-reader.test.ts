import assert from "node:assert/strict";
import test from "node:test";
import { platformSession } from "../../src/web/platform-session.ts";
import { organizationSession } from "../../src/web/organization-session.ts";
import { sessionStartup, startupReader } from "../../src/web/startup-reader.ts";

const profile = { id: "user_A", name: "A", workspace: "11", organizations: [] };
const capabilities = { items: [{ name: "identity.organizations", version: 1, status: "available" }] };
const organizations = { items: [{ id: "org_A", name: "A" }], active_organization_id: "org_A" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("one attempt starts identity and discovery together and shares their reads with organizations", async () => {
  const identity = deferred<typeof profile>();
  const discovery = deferred<Response>();
  const calls: string[] = [];
  const api = { me: () => { calls.push("me"); return identity.promise; }, workspaces: async () => { calls.push("workspaces"); return []; } };
  const transport = { call: async (path: string) => { calls.push(path); return path === "capabilities" ? discovery.promise : Response.json(organizations); }, mutation: async () => Response.json({}) };
  const reader = startupReader(api, transport);
  assert.deepEqual(calls, ["me", "capabilities"]);
  discovery.resolve(Response.json(capabilities));
  assert.deepEqual(await reader.organizations.capabilities!(), capabilities);
  assert.deepEqual(await reader.organizations.list(), organizations);
  identity.resolve(profile);
  assert.equal(await reader.me(), profile);
  assert.equal(await reader.me(), profile);
  assert.ok((await reader.capabilities())?.has("identity.organizations"));
  await Promise.all([reader.workspaces(), reader.workspaces()]);
  assert.deepEqual(calls, ["me", "capabilities", "identity/organizations", "workspaces"]);
});

test("failed attempts can be replaced and pages never share identity", async () => {
  let count = 0;
  const api = { me: async () => { if (++count === 1) throw new Error("offline"); return profile; }, workspaces: async () => [] };
  const transport = { call: async () => Response.json(capabilities), mutation: async () => Response.json({}) };
  await assert.rejects(startupReader(api, transport).me(), /offline/);
  assert.equal(await startupReader(api, transport).me(), profile);
  const other = startupReader({ ...api, me: async () => ({ ...profile, id: "user_B", workspace: "22" }) }, transport);
  assert.equal((await other.me()).id, "user_B");
  assert.equal((await other.me()).workspace, "22");
});

test("absent discovery preserves probing semantics and does not prefetch optional organizations", async () => {
  const calls: string[] = [];
  const reader = startupReader({ me: async () => profile, workspaces: async () => [] }, {
    call: async path => { calls.push(path); return new Response(null, { status: 404 }); },
    mutation: async () => Response.json({}),
  });
  assert.equal(await reader.capabilities(), null);
  assert.equal(await reader.organizations.capabilities!(), null);
  assert.deepEqual(calls, ["capabilities"]);
});


test("closing the page while organizations load prevents auto-selection and retry timers", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const pending = deferred<Response>();
  const started = deferred<void>();
  let mutations = 0;
  let calls = 0;
  let selected = 0;
  const transport = { call: async (path: string) => {
    calls++;
    if (path === "capabilities") return Response.json(capabilities);
    started.resolve(); return pending.promise;
  }, mutation: async () => { mutations++; return Response.json({}); } };
  const organization = organizationSession(transport, controller.signal, () => { selected++; });
  organization.load();
  await started.promise;
  controller.abort();
  organization.selection.stop();
  pending.resolve(Response.json({ items: [{ id: "org_A", name: "A" }], active_organization_id: null }));
  for (let i = 0; i < 20; i++) await Promise.resolve();
  t.mock.timers.tick(600_000);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(mutations, 0);
  assert.equal(selected, 0);
  assert.equal(calls, 2);
  assert.deepEqual(organization.selection.state(), { kind: "hidden" });
});


test("a lost selection is reconciled before retry captures its startup snapshot", async () => {
  let actual = "11";
  let first = true;
  let reads = 0;
  const api = {
    me: async () => { reads++; return { ...profile, workspace: actual }; },
    workspaces: async () => [{ id: actual, org: "org_A", name: "A", role: "owner" }],
    select: async (id: string) => {
      actual = id;
      if (first) { first = false; throw new Error("receipt lost after commit"); }
      return { workspace: { id, org: "org_A", name: "A", role: "owner" } };
    },
  };
  let now = 0;
  const startup = sessionStartup(api, { call: async () => Response.json({ items: [] }), mutation: async () => Response.json({}) }, () => now);
  const initial = await startup.read(null);
  assert.equal(initial.profile.workspace, "11");
  assert.equal(reads, 1, "reconciliation shares the initial identity read");
  now = 299_999; assert.equal(startup.refreshDue(), false);
  assert.equal(startup.refreshIn(), 1);
  now = 300_000; assert.equal(startup.refreshDue(), true);
  assert.equal(startup.refreshIn(), 0);
  await assert.rejects(startup.selection.choose("22"), /receipt lost/);
  assert.equal(startup.selection.uncertain(), true);
  const retried = await startup.read(null);
  assert.equal(retried.profile.workspace, "22");
  assert.equal(startup.selection.active(), "22");
  assert.equal(startup.selection.uncertain(), false);
  assert.equal((await startup.reader()!.workspaces())[0].id, "22");
});


for (const email of ["operator@example.test", 42, undefined]) test(`footer uses the startup profile without losing email ${String(email)}`, async () => {
  let freshReads = 0;
  const api = platformSession({ origin: "https://edge.example.test", timeoutMs: 1000 }, async () => Response.json({ ...profile, email }));
  const startup = sessionStartup(api, {
    call: async path => {
      if (path === "identity/me") { freshReads++; return Response.json({ name: "Updated", email: "updated@example.test" }); }
      return Response.json({ items: [] });
    }, mutation: async () => Response.json({}),
  });
  await startup.read(null);
  const account = startup.accountProfile(new AbortController().signal);
  assert.deepEqual(await account.read(), { name: "A", email: typeof email === "string" ? email : null, photo: null, source: null });
  assert.equal(freshReads, 0);
  assert.deepEqual(await account.read(), { name: "Updated", email: "updated@example.test", photo: null, source: null });
  assert.equal(freshReads, 1, "an explicit later read still checks the server");
});


for (const invalidation of ["expiry", "renewed deadline", "selection", "pagehide"]) test(`an unused footer seed is discarded after ${invalidation}`, async () => {
  let now = 0;
  let freshReads = 0;
  const controller = new AbortController();
  const startup = sessionStartup({ me: async () => profile, workspaces: async () => [], select: async id => ({ workspace: { id, org: "org_A", name: "A", role: "owner" } }) }, {
    call: async path => {
      if (path === "identity/me") { freshReads++; return Response.json({ name: "Fresh" }); }
      return Response.json({ items: [] });
    }, mutation: async () => Response.json({}),
  }, () => now);
  await startup.read(null);
  const account = startup.accountProfile(controller.signal);
  if (invalidation === "expiry") now = 300_000;
  if (invalidation === "renewed deadline") { now = 300_000; startup.checked(); }
  if (invalidation === "selection") await startup.selection.choose("22");
  if (invalidation === "pagehide") {
    controller.abort();
    await assert.rejects(account.read(), { name: "AbortError" });
    assert.equal(freshReads, 0);
  } else {
    assert.equal((await account.read())?.name, "Fresh");
    assert.equal(freshReads, 1);
  }
});


test("closing the page during the first footer read discards its late snapshot", async () => {
  const controller = new AbortController();
  const startup = sessionStartup({ me: async () => profile, workspaces: async () => [], select: async id => ({ workspace: { id, org: "org_A", name: "A", role: "owner" } }) }, {
    call: async () => Response.json({ items: [] }), mutation: async () => Response.json({}),
  });
  await startup.read(null);
  const reading = startup.accountProfile(controller.signal).read();
  controller.abort();
  await assert.rejects(reading, { name: "AbortError" });
});
