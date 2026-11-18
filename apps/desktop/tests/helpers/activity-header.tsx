import "../../src/locales/catalogs";
import "../../src/styles/global.css";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { RegistroDeTrabajo } from "../../src/features/chat/components/activity/TurnActivity";
import { observedActivityAction } from "../../src/features/chat/activityPresentation";
import { pasoDe, type Paso } from "../../src/lib/steps";

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") ?? "dark";

const rehydrated = new URLSearchParams(location.search).get("mode") === "rehydrated";

function Fixture() {
  const [stopping, setStopping] = createSignal(false);
  const [active, setActive] = createSignal(true);
  const [open, setOpen] = createSignal(false);
  const [steps, setSteps] = createSignal<Paso[]>(rehydrated ? [] : [{ ...pasoDe("command_execution", "pnpm test:unit"), corriendo: true }]);
  const presentation = { get stopping() { return stopping(); }, get latestAction() { return observedActivityAction({ role: "system", text: "", paso: steps().at(-1) }); } };
  return <main class="max-w-3xl bg-surface p-6 text-neutral-950">
    <nav class="mb-4 flex flex-wrap gap-3 text-sm">
      <button data-stop onClick={() => setStopping(true)}>Stop</button>
      <button data-done onClick={() => setActive(false)}>Done</button>
      <button data-read onClick={() => setSteps([...steps(), { ...pasoDe("Read", "src/features/chat/Chat.tsx"), corriendo: true }])}>Read</button>
      <button data-reset onClick={() => { setStopping(false); setActive(true); }}>Resume</button>
    </nav>
    <p data-existing-response class="mb-3">Previously loaded response remains visible.</p>
    <RegistroDeTrabajo {...presentation} animando={!rehydrated} observed pasos={steps()} corriendo={active()} abierto={open()} onAlternar={setOpen} />
  </main>;
}

render(() => <Fixture />, document.getElementById("root")!);
