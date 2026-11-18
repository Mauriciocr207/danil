import assert from "node:assert/strict";
import test from "node:test";
import { boot, sleep } from "../helpers/jsdom-app.mjs";
import { chat, openTask, pushedPoll, responses, session, turns } from "../helpers/push-fixture.mjs";
import { waitFor } from "../helpers/wait-for.mjs";

for (const [terminalFirst, payload, keyboard] of [[false, false, false], [true, false, false], [false, true, false], [false, false, true]]) test(`forcing the queue interrupts before sending (${terminalFirst ? "terminal first" : "ack first"}, ${payload ? "mention and attachment" : "plain"}, ${keyboard ? "keyboard" : "arrow"})`, async () => {
  const stream = pushedPoll();
  let active = true, acknowledge;
  const sent = [], saved = [];
  const queued = { id: "q1", text: payload ? "@t2 next instruction" : "next instruction", provider: "codex", model: "gpt-5.6", effort: null, permission_mode: "auto", attachments: payload ? ["/lab/attachment.png"] : [], task_mentions: payload ? [{ target: { kind: "task", projectId: "p1", sessionId: "t2" }, text: "@t2", start: 0, end: 3 }] : [] };
  const remainder = { ...queued, id: "q2", text: "!echo remaining", task_mentions: [], attachments: [] };
  const app = await boot("listo", `queue-force-${terminalFirst}-${payload}-${keyboard}`, responses({
    service_poll: stream.poll, service_filter: null,
    prepare_attachments: ({ paths }) => paths,
    list_active_turns: () => active ? ["t1"] : [],
    load_history: ({ id }) => session(id, turns(0, 4)),
    load_queue: ({ session }) => session === "t1" ? [queued, remainder] : [],
    save_queue: ({ queued }) => { saved.push(queued); return null; },
    stop_turn: () => new Promise(resolve => { acknowledge = resolve; }),
    inject_message: () => ({ id: "wrong-steer" }),
    send_message: args => { sent.push(args); active = true; return "t1"; },
  }));
  await openTask(app, "t1");
  const button = await waitFor(() => [...app.w.document.querySelectorAll("button")].find(element => /^(Mandar ahora|Interrumpir y enviar|Detener el turno y enviar) el mensaje 1 de la cola$/.test(element.getAttribute("aria-label") ?? "")), "queue force action missing");
  assert.match(button.getAttribute("aria-label"), /^(Mandar ahora|Interrumpir y enviar|Detener el turno y enviar) /);
  if (keyboard) {
    const input = app.w.document.querySelector("textarea");
    assert.ok(input, "composer missing");
    input.dispatchEvent(new app.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  } else button.click();
  await sleep(80);
  assert.equal(app.commands.filter(command => command === "stop_turn").length, 1);
  assert.equal(app.commands.filter(command => command === "inject_message").length, 0);
  assert.equal(sent.length, 0);
  assert.ok(app.w.document.body.textContent.includes(queued.text), "pending message disappeared before closure");
  assert.ok(saved.at(-1)?.some(item => item.id === queued.id), "pending message was removed from durable queue");
  const terminal = async () => { active = false; stream.push({ events: [chat("done", { ok: false })] }); await sleep(120); };
  if (terminalFirst) await terminal(); else { acknowledge(null); await sleep(120); }
  assert.equal(sent.length, 0, "both cancellation ack and terminal are required");
  if (terminalFirst) acknowledge(null); else await terminal();
  await waitFor(() => sent.length === 1, "replacement was not sent after closure");
  await sleep(100);
  assert.equal(sent.length, 1);
  assert.ok(saved.at(-1)?.some(item => item.id === remainder.id), "remaining queued item disappeared");
  assert.equal(sent[0].prompt, queued.text);
  if (payload) assert.deepEqual(sent[0].attachments, queued.attachments);
  assert.deepEqual(sent[0].taskMentions, queued.task_mentions);
  assert.equal(app.commands.filter(command => command === "stop_turn").length, 1);
  assert.equal(app.commands.filter(command => command === "inject_message").length, 0);
});
