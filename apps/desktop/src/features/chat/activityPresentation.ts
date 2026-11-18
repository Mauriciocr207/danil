import { activityMessageKind, type ActivityObservationKind } from "../../lib/activityObservation.ts";
import { t } from "../../lib/i18n.ts";
import { pasoDe, rotuloDeFila, type Paso } from "../../lib/steps.ts";
import type { Msg } from "./messageTypes.ts";

export type ActivityAction =
  | { kind: "step"; step: Paso }
  | { kind: "thinking" }
  | { kind: "responding" }
  | { kind: "delegated"; title: string };

/** The projection supplies the actual last update, including edits to older native messages. */
export function observedActivityAction(message: Msg | null | undefined, observedKind?: ActivityObservationKind | null): ActivityAction | null {
  if (!message) return null;
  const kind = observedKind ?? activityMessageKind(message);
  switch (kind) {
    case "step": return { kind, step: message.paso ?? pasoDe(message.text) };
    case "delegated": return message.fromTask ? { kind, title: message.fromTask.title } : null;
    case "thinking": return { kind };
    case "responding": return { kind };
    default: return null;
  }
}

export function presentActivity(input: {
  active: boolean;
  stopping?: boolean;
  blocked?: boolean;
  paused?: boolean;
  action?: ActivityAction | null;
  label?: string;
}): { label: string; animate: boolean } {
  if (input.stopping) return { label: t("chat.turn.stopping"), animate: false };
  if (!input.active) return { label: t("chat.activity.finished"), animate: false };
  const animate = !input.blocked && !input.paused;
  if (input.blocked) return { label: t("chat.activity.title"), animate: false };
  const action = input.action;
  if (!action) return { label: input.label ?? t("chat.activity.running"), animate };
  switch (action.kind) {
    case "step": {
      const row = rotuloDeFila({ clase: action.step.clase, pasos: [action.step] });
      return { label: [row.verbo, row.sujeto].filter(Boolean).join(" "), animate };
    }
    case "thinking": return { label: t("chat.reasoning.thinking"), animate };
    case "responding": return { label: t("chat.activity.responding"), animate };
    case "delegated": return { label: t("chat.activity.delegated", { title: action.title }), animate };
  }
}
