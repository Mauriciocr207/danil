import { createEffect, createSignal, createUniqueId, For, Match, onCleanup, Show, Switch } from "solid-js";
import { ACTIVITY_MOTIONS, createActivityMotionCycle, createActivityMotionPreference } from "./activityMotion";
import "./activity-indicator.css";

const PARTICLES = Array.from({ length: 13 }, (_, index) => index);

/** Lifecycle is supplied by the caller; this component only owns motion and its resources. */
export function ActivityIndicator(props: { paused?: boolean; active?: boolean; mode?: "running" | "paused" | "finished" }) {
  const cycle = createActivityMotionCycle();
  const [motion, setMotion] = createSignal(cycle.initial);
  const [mounted, setMounted] = createSignal(false);
  const jellyId = `activity-jelly-${createUniqueId()}`;
  const preference = createActivityMotionPreference(mounted);
  const mode = () => props.mode ?? (props.active === false ? "finished" : props.paused ? "paused" : "running");
  const paused = () => mode() !== "running" || !preference();
  createEffect(() => {
    if (mode() !== "finished") { setMounted(true); return; }
    if (!mounted()) return;
    const exit = setTimeout(() => setMounted(false), 250);
    onCleanup(() => clearTimeout(exit));
  });
  createEffect(() => {
    if (!mounted() || paused()) return;
    motion();
    const change = setTimeout(() => setMotion(cycle.next()), 6_000 + Math.random() * 2_000);
    onCleanup(() => clearTimeout(change));
  });
  return <span class="activity-dots-slot" classList={{ "activity-dots-exited": mode() !== "running" }} aria-hidden="true" data-activity-slot="">
    <Show when={mounted()}>
      <span class="activity-motion" classList={{ "activity-motion-paused": paused() }} data-activity-dots="">
        <For each={ACTIVITY_MOTIONS}>{name => <span class="activity-motion-layer" classList={{ "activity-motion-selected": motion() === name }} data-activity-variant={name}>
          <span class={`activity-loader-${name}`}>
            <Switch fallback={<span class="container"><span class="dot" /><span class="dot" /><span class="dot" /></span>}>
              <Match when={name === "quantum"}><span class="container"><For each={PARTICLES}>{() => <span class="particle" />}</For></span></Match>
              <Match when={name === "jellyTriangle"}>
                <span class="container"><svg class="svg" viewBox="0 0 12.25 12.25" width="12.25" height="12.25" style={{ filter: `url(#${jellyId})` }}>
                  <circle class="dot" /><circle class="dot" /><circle class="dot" /><circle class="traveler" />
                  <defs><filter id={jellyId}><feGaussianBlur in="SourceGraphic" stdDeviation="1.361111" result="blur" /><feColorMatrix in="blur" type="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 18 -7" result="ooze" /><feBlend in="SourceGraphic" in2="ooze" /></filter></defs>
                </svg></span>
              </Match>
            </Switch>
          </span>
        </span>}</For>
      </span>
    </Show>
  </span>;
}

export function ActivityCaption(props: { active: boolean; text: string }) {
  const preference = createActivityMotionPreference(() => props.active);
  return <span class="activity-caption min-w-0 truncate" classList={{ "activity-caption-running": props.active && preference() }} data-activity-label="">{props.text}</span>;
}
