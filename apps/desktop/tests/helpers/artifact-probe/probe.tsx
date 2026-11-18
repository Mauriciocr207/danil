import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import ArtifactViewer from "../../../src/features/artifacts/ArtifactViewer";
import { setMachineRoute } from "../../../src/lib/invoke";

const [path, setPath] = createSignal("/a.txt");
const [session, setSession] = createSignal("one");
const pending: { resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = [];
setMachineRoute(async (command) => {
  if (command !== "preview_file") return null;
  return new Promise((resolve, reject) => { pending.push({ resolve, reject }); });
});
Object.assign(window, { probe: {
  setPath, setSession, reads: () => pending.length,
  resolve(index: number, text: string) {
    pending[index].resolve({ kind: "text", rel: "document.txt", text, bytes: text.length, truncated: false, data_url: null, pdf: null });
  },
  reject(index: number) { pending[index].reject({ what: "Stale failure", detail: "old_read" }); },
} });
render(() => <div data-probe-ready><ArtifactViewer path={path()} rel={path().slice(1)} session={session()} kind="input" /></div>, document.getElementById("root")!);
