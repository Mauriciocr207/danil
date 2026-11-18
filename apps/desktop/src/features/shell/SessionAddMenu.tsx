import { createSignal, For, Show } from "solid-js";
import { t } from "../../lib/i18n";
import { capabilities } from "../../lib/platform";
import { ITEM_DE_MENU } from "../../ui/Popover";
import { matchesName } from "./hidden-workspaces";
import type { sessionRail } from "./session-groups";
import { freeSessionRow } from "./session-rail-view";
import WorkspaceSearch, { SEARCH_FROM } from "./WorkspaceSearch";

type Rail = ReturnType<typeof sessionRail>;
const NOTE = "m-0 px-2 py-1.5 text-caption text-neutral-500";
const errorKey = (e: unknown) => {
  const detail = (e as { detail?: string } | null)?.detail;
  return detail === "too_many_contexts" ? "danil.error.too_many_contexts" : detail === "organization_auth_required" ? "shell.workspaces.sessions_auth" : detail === "cancelled" ? "shell.workspaces.sessions_cancelled" : "shell.workspaces.sessions_failed";
};

export function SessionAddEntries(props: { sessions: Rail; signedIn: boolean; onStep: () => void }) {
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const run = async (action: () => Promise<unknown>) => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try { await action(); } catch (e) {
      setError(errorKey(e));

    }
    finally { setBusy(false); }
  };
  return <>
    <button type="button" role="menuitem" class={ITEM_DE_MENU} disabled={busy()} data-add-danil-step="" onClick={() => {
      if (props.sessions.groups()?.length || props.signedIn) { props.onStep(); props.sessions.refresh(); }
      else void run(props.sessions.sessions.addAccount);
    }}>{t("shell.workspaces.add_danil")}</button>
    <Show when={props.sessions.groups()?.some((g) => (g.available_contexts ?? 0) > 0)}><p role="status" class={NOTE}>{t("shell.workspaces.new_available")}</p></Show>
    <Show when={(props.sessions.groups()?.length ?? 0) > 0}>
      <button type="button" role="menuitem" class={ITEM_DE_MENU} disabled={busy()} onClick={() => void run(props.sessions.sessions.addAccount)}>{t("shell.workspaces.add_session")}</button>
    </Show>
    <Show when={error()}>{(key) => <p role="status" class={NOTE}>{t(key())}</p>}</Show>
  </>;
}

export function SessionAddStep(props: { sessions: Rail; context?: string | null; query: string; onQuery: (s: string) => void; onClose: () => void; onOpen: (id: string) => void }) {
  const groups = () => (props.sessions.groups() ?? []).filter((g) => !props.context || g.context_id === props.context);
  const size = () => groups().reduce((n, g) => n + (g.available?.length ?? 0), 0);
  return <div data-danil-workspaces="">
    <Show when={size() >= SEARCH_FROM}><WorkspaceSearch value={props.query} onInput={props.onQuery} /></Show>
    <div class="max-h-64 overflow-y-auto p-0.5">
      <For each={groups()}>{(g) => <div data-session-context={g.context_id}>
        <p class={NOTE}>{g.email} · {g.org_name ?? g.org}</p>
        <Show when={freeSessionRow(g)}>{(free) => <button type="button" role="menuitem" class={ITEM_DE_MENU} onClick={() => { props.sessions.add(g.context_id, free().id); props.onClose(); props.onOpen(free().id); }}>{t("shell.workspaces.free_workspace")}</button>}</Show>
        <Show when={g.available} fallback={<p class={NOTE}>{t("shell.workspaces.danil_loading")}</p>}>
          <For each={(g.available ?? []).filter((w) => !g.added?.has(w.id) && matchesName(w.name, props.query))}>{(w) => <button type="button" role="menuitem" class={ITEM_DE_MENU} data-add-danil={w.id} onClick={() => { props.sessions.add(g.context_id, w.id); props.onClose(); props.onOpen(w.id); }}>{w.name}</button>}</For>
        </Show>
      </div>}</For>
    </div>
  </div>;
}

export const usesSessionMenu = (rail: Rail, signedIn: boolean) => capabilities().nativeWindow && (rail.groups() !== null || !signedIn);
