import { listen } from "./serviceEvents";

/** Los avisos repetidos de la misma sesión no reinician el contexto. */
export function listenDanilConnectionChange(handler: () => void) {
  type Connection = {
    state?: string;
    account?: string | null;
    computer_id?: string | null;
    email?: string | null;
    account_name?: string | null;
    name?: string | null;
    online?: boolean;
  };
  let previous: string | null = null;
  return listen<Connection>("danil-connect", ({ payload }) => {
    const state = payload?.state;
    const key = state === "connected" || state === "disconnected"
      ? JSON.stringify([state, payload.account, payload.computer_id, payload.email, payload.account_name, payload.name, payload.online])
      : null;
    if (key !== null && key === previous) return;
    previous = key;
    handler();
  });
}
