import { createOrganizationSelection, isOrganizationSelectionRequired, type OrganizationSelection } from "@terminus/computers";
import { listenDanilConnectionChange } from "../../lib/danilConnectionEvents";
import { cancelEdgeWrites, edgeFetch, onEdgeProblem, ORGANIZATION_CHANGED } from "../../lib/edge";
import { invoke } from "../../lib/invoke";
import { edgeOrganizationSource } from "./organization-edge";
import { hasSessionGroups } from "./session-groups";

export function desktopOrganizations(): OrganizationSelection {
  const selection = createOrganizationSelection(
    // Una llamada por intento; la clave de cada `select` se repite en sus reintentos.
    edgeOrganizationSource(edgeFetch, cancelEdgeWrites),
    {
      onSelected: (organization, workspace) => {
        window.dispatchEvent(new CustomEvent(ORGANIZATION_CHANGED, { detail: { organization: organization.id, workspace } }));
        // Solo tras un cambio: fuera de la carga inicial.
        void import("../machines/store").then((m) => m.refetchMachines());
      },
    },
  );
  let legacy = false;
  const load = async () => {
    const status = await invoke<{ state: string; sessions?: unknown[] }>("danil_session_status").catch(() => null);
    legacy = !status?.sessions;
    if (legacy && status?.state === "connected") await selection.load();
  };
  onEdgeProblem((e) => {
    if (!hasSessionGroups() && isOrganizationSelectionRequired(e)) selection.report(e);
  });
  void listenDanilConnectionChange(() => void load()).catch(() => {});
  void load();
  return selection;
}
