import { onCleanup, onMount } from "solid-js";
/** Busy is a lifecycle fact, not evidence that new output is arriving. */
export function ActivityDots(props: { paused?: boolean; active?: boolean; completion?: { take: () => boolean } }) {
  let slot: HTMLSpanElement | undefined;
  let exit: Animation | undefined;
  onMount(() => {
    if (!slot?.isConnected || props.active !== false || !props.completion?.take() || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    exit = slot.animate([{ width: "22px", marginRight: "8px" }, { width: "0px", marginRight: "0px" }], { duration: 180, easing: "ease-out" });
  });
  onCleanup(() => exit?.cancel());
  return <span ref={slot} class="activity-dots-slot" classList={{ "activity-dots-exited": props.active === false }} aria-hidden="true" data-activity-slot="" onTransitionRun={() => { if (props.active === false) props.completion?.take(); }}>
    <svg width="22" height="20" viewBox="0 0 22 20" class="activity-dots" classList={{ "activity-dots-paused": props.paused || props.active === false }} data-activity-dots="">
      <circle cx="4" cy="10" r="2" /><circle cx="11" cy="10" r="2" /><circle cx="18" cy="10" r="2" />
    </svg>
  </span>;
}
