import type { Fleet, Listed } from "@terminus/fleet";
import { createRoot, createSignal } from "solid-js";

/**
 * Los workspaces de Danil de una organización de pago (plan 2026-11-18, A2 y A3): lo que
 * contesta `list_workspaces` en sus máquinas `kind=organization` de `/v1/machines`. Nada más
 * decide qué es de Danil: ni el índice del motor ni el vínculo del prototipo.
 */
const [revision, bump] = createRoot(() => createSignal(0));
let fleet: Fleet | null = null;
const reading = new Map<string, Promise<void>>();

/** La flota de la ventana; `null` al cerrar sesión, y entonces no hay nada de Danil. */
export function setDanilFleet(next: Fleet | null) {
  fleet = next;
  reading.clear();
  bump((n) => n + 1);
}

/** Una respuesta de `list_workspaces`, tolerante: solo filas con `id`. */
export function listedOf(value: unknown): Listed[] | null {
  const rows = (value as { workspaces?: unknown } | null)?.workspaces;
  if (!Array.isArray(rows)) return null;
  return rows.flatMap((w) => {
    const id = (w as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !id) return [];
    const name = (w as { name?: unknown }).name;
    return [{ id, name: typeof name === "string" && name.trim() ? name : id }];
  });
}

/** Lo que contestó `machine` en `list_workspaces` (la web lo atribuye desde `webListing`). */
export function noteListing(machine: string, value: unknown) {
  const listed = listedOf(value);
  if (!fleet || !listed) return;
  fleet.setListing(machine, listed);
  bump((n) => n + 1);
}

/** Los de `organization`, o `null` mientras su máquina no contestó: la fuente no está asentada. */
export function danilAvailable(organization: string | null): Listed[] | null {
  revision();
  return organization && fleet ? fleet.available(organization) : null;
}

/** Las máquinas `kind=organization` de `organization`; vacío sin flota. */
export function danilMachines(organization: string | null): string[] {
  revision();
  return organization && fleet ? fleet.organizationMachines(organization) : [];
}

/** Pregunta `list_workspaces` a las máquinas de `organization`, una lectura a la vez por organización. */
export function readDanil(organization: string | null): Promise<void> {
  const current = fleet;
  if (!organization || !current) return Promise.resolve();
  const running = reading.get(organization);
  if (running) return running;
  const read = Promise.all(
    current.organizationMachines(organization).map(async (machine) => {
      const slice = await current.read({ machine, workspace: null, command: "list_workspaces" }).catch(() => null);
      if (slice?.has && fleet === current) noteListing(machine, slice.value);
    }),
  ).then(() => undefined);
  reading.set(organization, read);
  return read.finally(() => reading.delete(organization));
}
