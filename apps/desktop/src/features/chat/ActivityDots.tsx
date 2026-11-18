
/** Busy is a lifecycle fact, not evidence that new output is arriving. */
export function ActivityDots(props: { paused?: boolean }) {
  return <span class="activity-dots" classList={{ "activity-dots-paused": props.paused }} aria-hidden="true" data-activity-dots="">
    <span /><span /><span />
  </span>;
}
