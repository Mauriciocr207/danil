import { For, Show } from "solid-js";
import { t } from "../../lib/i18n";
import { emptyReasonKey, normalizeEmptyReason } from "./session-empty";
import type { sessionRail } from "./session-groups";

export function SessionEmptyNotice(props: { sessions: ReturnType<typeof sessionRail> }) {
  return <>
    <Show when={props.sessions.emptyReason()}>{(reason) => <p role="status" class="m-0 px-2 py-1.5 text-caption text-neutral-500">{t(emptyReasonKey(reason()))}</p>}</Show>
    <For each={props.sessions.removed()}>{(item) => <p role="status" data-removed-context={item.context_id} class="m-0 px-2 py-1.5 text-caption text-neutral-500">{t(emptyReasonKey(normalizeEmptyReason(item.reason) ?? "unknown"))}</p>}</For>
  </>;
}
