import { listenDanilConnectionChange } from "../../lib/danilConnectionEvents";
import { edgeFetch, edgeUntil, ORGANIZATION_CHANGED, type WorkspaceList } from "../../lib/edge";
import { invoke } from "../../lib/invoke";
import { availableDanilCredits, type DanilCreditsSource } from "./danil-credits";

const RETRY_BUDGET_MS = 5_000;

/** Solo un vínculo publicado por Workspaces atribuye el saldo al workspace del motor. */
export const desktopCredits: DanilCreditsSource = {
  async readBalance(signal) {
    const { active } = await invoke<{ active: string | null }>("list_workspaces");
    if (!active || signal.aborted) return null;

    const patience = { signal, retryBudgetMs: RETRY_BUDGET_MS };
    const directory = await edgeUntil<WorkspaceList>("GET", "/v1/workspaces", undefined, patience, { send: edgeFetch });
    const bound = directory.body.items.find((row) => row.engine_workspace_id === active);
    if (!bound?.org || signal.aborted) return null;

    const reply = await edgeUntil("GET", "/v1/credits/balance", undefined, patience, { send: edgeFetch });
    return !signal.aborted && reply.status === 200 ? availableDanilCredits(reply.body, bound.org) : null;
  },

  subscribe(changed) {
    const events = ["harness:workspace", ORGANIZATION_CHANGED];
    for (const event of events) window.addEventListener(event, changed);
    const connection = listenDanilConnectionChange(changed).catch(() => undefined);
    return () => {
      for (const event of events) window.removeEventListener(event, changed);
      void connection.then((stop) => stop?.());
    };
  },
};
