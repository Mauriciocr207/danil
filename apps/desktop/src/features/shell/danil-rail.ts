import type { DanilMenu } from "./DanilAddMenu";
import { railHidden, railVisible } from "./hidden-workspaces.ts";
import { type DanilRail, danilRail } from "./workspace-added-wiring.ts";

export type DanilView = { available: readonly { id: string; name: string }[] | null; added: ReadonlySet<string> | null };

/**
 * El riel con los de Danil: los locales menos los ocultos, los de Danil solo si la persona los
 * agregó (también los que el riel aún no conocía) y el abierto. Sin la fuente asentada o sin
 * saber los agregados, el riel se queda como estaba: no se vacía.
 */
export function railWithDanil<T extends { id: string }>(list: readonly T[], hidden: ReadonlySet<string>, open: string | null, danil: DanilView, make: (w: { id: string; name: string }) => T): T[] {
  const { available, added } = danil;
  if (!available || !added) return railVisible(list, hidden, open);
  const ids = new Set(available.map((w) => w.id));
  const shown = list.filter((w) => w.id === open || (ids.has(w.id) ? added.has(w.id) : !hidden.has(w.id)));
  const known = new Set(list.map((w) => w.id));
  return [...shown, ...available.filter((w) => added.has(w.id) && !known.has(w.id)).map(make)];
}

/** Los de Danil de la organización activa que la persona todavía no agregó; `null` sin la fuente. */
export function danilToAdd(danil: DanilView): readonly { id: string; name: string }[] | null {
  if (!danil.available) return null;
  const added = danil.added ?? new Set<string>();
  return danil.available.filter((w) => !added.has(w.id));
}

/** Lo que el «+» necesita de los de Danil; agregar uno también lo abre. */
export function danilMenuOf(danil: DanilRail, view: DanilView, open: (id: string) => void): DanilMenu {
  return {
    signedIn: danil.signedIn(),
    organization: danil.organization(),
    toAdd: danilToAdd(view),
    others: danil.others(),
    onList: danil.refresh,
    onAdd: (id) => (danil.add(id), open(id)),
    onSwitch: danil.switchTo,
  };
}

/** Lo que la columna del riel usa de los de Danil, sobre sus ocultos locales. */
export function columnDanil(hidden: { ids: () => ReadonlySet<string>; show: (id: string) => void }) {
  const danil = danilRail(hidden.ids, (ids) => ids.forEach(hidden.show));
  const view = (): DanilView => ({ available: danil.available(), added: danil.added() });
  const make = (w: { id: string; name: string }) => ({ id: w.id, name: w.name, logo: null as string | null });
  return {
    danil,
    view,
    visible: <T extends { id: string; name: string; logo: string | null }>(list: readonly T[], open: string | null) => railWithDanil<T | ReturnType<typeof make>>(list, hidden.ids(), open, view(), make),
    /** Los ocultos del «+»: solo los locales; un workspace de Danil se quita, no se oculta. */
    hiddenRows: <T extends { id: string }>(list: readonly T[]) => railHidden(list, hidden.ids()).filter((w) => !danil.isDanil(w.id)),
  };
}

/** El nombre de un cuadro para quien no ve la marca ni el distintivo. */
export const tileLabel = (name: string, isDanil: boolean, state: string | null, t: (key: string, values: Record<string, string>) => string) => {
  const named = isDanil ? t("shell.workspaces.danil_tile", { name }) : name;
  return state ? t("shell.workspaces.tile_with_state", { name: named, state }) : named;
};
