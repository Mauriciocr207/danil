import assert from "node:assert/strict";
import test from "node:test";
import { activityByProject, byRecent, recentProjects, rememberPick } from "../../src/features/projects/recent.ts";
import { lastActivity } from "../../../../packages/tasks/src/view.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 17);
const project = (id: string, name: string, created_at: number, updated_at = created_at) => ({ id, name, created_at, updated_at });
const ids = (rows: { id: string }[]) => rows.map((p) => p.id);

test("a project with recent tasks goes first; one without tasks falls back to its creation", () => {
  const rows = [project("old", "Old", NOW - 30 * DAY), project("busy", "Busy", NOW - 90 * DAY), project("new", "New", NOW - DAY)];
  assert.deepEqual(ids(byRecent(rows, { busy: NOW }, {})), ["busy", "new", "old"]);
});

test("updated_at of the project record does not count as activity", () => {
  const rows = [project("a", "A", NOW - 10 * DAY, NOW), project("b", "B", NOW - 5 * DAY, NOW - 5 * DAY)];
  assert.deepEqual(ids(byRecent(rows, {}, {})), ["b", "a"]);
});

test("the last pick counts like activity, and the maximum of the three dates wins", () => {
  const rows = [project("a", "A", NOW - 10 * DAY), project("b", "B", NOW - 20 * DAY), project("c", "C", NOW - 3 * DAY)];
  assert.deepEqual(ids(byRecent(rows, { a: NOW - 15 * DAY }, { b: NOW - DAY })), ["b", "c", "a"]);
});

test("ties are stable and deterministic: by name, then by id", () => {
  const rows = [project("z", "beta", NOW), project("y", "Alpha", NOW), project("x", "alpha", NOW), project("w", "Gamma", NOW)];
  assert.deepEqual(ids(byRecent(rows, {}, {})), ["x", "y", "z", "w"]);
  assert.deepEqual(ids(byRecent([...rows].reverse(), {}, {})), ["x", "y", "z", "w"]);
});

test("creation in seconds and activity in ms compare on the same scale", () => {
  const rows = [project("secs", "Secs", Math.floor((NOW - DAY) / 1000)), project("ms", "Ms", NOW - 2 * DAY)];
  assert.deepEqual(ids(byRecent(rows, {}, {})), ["secs", "ms"]);
});

test("without tasks or pref nothing fails and the newest come first", () => {
  const rows = [project("a", "A", NOW - 3 * DAY), project("b", "B", NOW - DAY), project("c", "C", 0)];
  const { visible, rest } = recentProjects(rows, {}, {}, "");
  assert.deepEqual(ids(visible), ["b", "a", "c"]);
  assert.deepEqual(rest, []);
});

test("with fewer than 8 projects there is no rest", () => {
  const rows = Array.from({ length: 5 }, (_, i) => project(`p${i}`, `P${i}`, NOW - i * DAY));
  const { visible, rest } = recentProjects(rows, {}, {}, "");
  assert.equal(visible.length, 5);
  assert.equal(rest.length, 0);
});

test("the current project stays visible even outside the cut", () => {
  const rows = Array.from({ length: 12 }, (_, i) => project(`p${i}`, `P${i}`, NOW - i * DAY));
  const { visible, rest } = recentProjects(rows, {}, {}, "p11");
  assert.deepEqual(ids(visible), ["p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p11"]);
  assert.deepEqual(ids(rest), ["p8", "p9", "p10"]);
  assert.equal(recentProjects(rows, {}, {}, "p2").visible.length, 8);
});

test("pref ids that no longer exist are ignored, and saving drops them", () => {
  const rows = [project("a", "A", NOW - 2 * DAY), project("b", "B", NOW - DAY)];
  assert.deepEqual(ids(recentProjects(rows, {}, { gone: NOW, a: NOW }, "gone").visible), ["a", "b"]);
  assert.deepEqual(rememberPick({ gone: NOW, a: NOW - DAY, b: Number.NaN }, "b", NOW, ["a", "b"]), { a: NOW - DAY, b: NOW });
  assert.deepEqual(rememberPick({ a: 1 }, "", NOW, ["a"]), { a: 1 });
});

test("activity per project is that of its latest live task", () => {
  const task = (last_turn_at: number | null, updated_at: number) => ({ id: String(updated_at), esperando: false, last_turn_at, updated_at, created_at: 0 });
  const activity = activityByProject({ "": [task(NOW, NOW)], a: [task(null, NOW - DAY), task(NOW - 2 * DAY, NOW)], b: [] }, lastActivity);
  assert.deepEqual(activity, { a: NOW - DAY });
});

test("31 projects with live tasks only in «Danil App»: it is among the 8 and 23 are folded", () => {
  const rows = Array.from({ length: 30 }, (_, i) => project(`old${i}`, `Old ${i}`, NOW - (400 - i) * DAY));
  rows.splice(17, 0, project("danil-app", "Danil App", NOW - 500 * DAY));
  const { visible, rest } = recentProjects(rows, { "danil-app": NOW }, {}, "");
  assert.equal(visible.length, 8);
  assert.equal(visible[0].id, "danil-app");
  assert.equal(rest.length, 23);
});
