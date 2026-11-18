import { type Component, type ComponentProps, type ParentProps, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { HandoffPresentation } from "../../../conversation-handoff";
import { t } from "../../../../lib/i18n";
import { cn } from "../../../../lib/utils";
import Adjuntos from "../../Attachments";

export function handoffStatus(handoff: NonNullable<HandoffPresentation>): string {
  switch (handoff.phase) {
    case "waiting-close": return t("chat.handoff.waiting_close");
    case "submitting": return t("chat.handoff.submitting");
    case "awaiting-start": return t("chat.handoff.awaiting_start");
  }
}

/** Queue owns pending text; once dispatch begins the transcript owns its optimistic message. */
export function PendingHandoff(props: {
  handoff: HandoffPresentation;
  bubble: Component<ParentProps>;
  userClass: string;
  miniatura: ComponentProps<typeof Adjuntos>["miniatura"];
  preview?: ComponentProps<typeof Adjuntos>["preview"];
}) {
  const pending = () => props.handoff?.phase === "waiting-close" ? props.handoff.pendingMessage : null;
  return <Show when={props.handoff}>{handoff => <section class="col-start-1 min-w-0" data-chat-handoff={handoff().phase}>
    <Show when={pending()}>{message => <div class={props.userClass} data-pending-handoff-input="">
      <Dynamic component={props.bubble}>
        <Show when={message().attachments}>{attachments => <Adjuntos rels={Array.from(attachments())} miniatura={props.miniatura} preview={props.preview} />}</Show>
        <p class="m-0 leading-[1.5] break-words whitespace-pre-wrap">{message().text}</p>
      </Dynamic>
    </div>}</Show>
    <p class={cn("m-0 mt-2 text-caption text-neutral-500", pending() && "text-right")} role="status">{handoffStatus(handoff())}</p>
  </section>}</Show>;
}
