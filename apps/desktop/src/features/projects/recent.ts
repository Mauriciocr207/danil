/** Cuántos proyectos abre el selector antes de «Más proyectos…». */
export const RECENT_LIMIT = 8;

/** Última vez que se eligió cada proyecto en este selector: id → epoch en ms. */
export type PickedAt = Record<string, number>;

type Ranked = { id: string; name: string; created_at?: number | null };

// Las tareas fechan en ms; un valor por debajo de 1e12 son segundos (no llega a 1e12 hasta el año 33658).
const ms = (at: number | null | undefined) =>
  typeof at === "number" && Number.isFinite(at) && at > 0 ? (at < 1e12 ? at * 1000 : at) : 0;

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** El máximo de su última tarea viva, su última elección y su creación; nunca `updated_at`. */
export function recency(project: Ranked, activity: Readonly<Record<string, number>>, picked: Readonly<PickedAt>): number {
  return Math.max(ms(activity[project.id]), ms(picked[project.id]), ms(project.created_at));
}

/** Del más reciente al más viejo; los empates, por nombre y después por id. */
export function byRecent<P extends Ranked>(projects: readonly P[], activity: Readonly<Record<string, number>>, picked: Readonly<PickedAt>): P[] {
  const at = new Map(projects.map((p) => [p.id, recency(p, activity, picked)]));
  return [...projects].sort((a, b) =>
    (at.get(b.id) ?? 0) - (at.get(a.id) ?? 0)
    || collator.compare(a.name, b.name)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Los `limit` más recientes y el resto; el proyecto `current` queda siempre entre los visibles. */
export function recentProjects<P extends Ranked>(
  projects: readonly P[],
  activity: Readonly<Record<string, number>>,
  picked: Readonly<PickedAt>,
  current: string,
  limit = RECENT_LIMIT,
): { visible: P[]; rest: P[] } {
  const sorted = byRecent(projects, activity, picked);
  const visible = sorted.slice(0, limit);
  const rest = sorted.slice(limit);
  const kept = current ? rest.findIndex((p) => p.id === current) : -1;
  if (kept >= 0) visible.push(...rest.splice(kept, 1));
  return { visible, rest };
}

/** La actividad de cada proyecto: la de su tarea viva que se movió más tarde. */
export function activityByProject<T>(tasks: Readonly<Record<string, readonly T[]>>, lastActivity: (task: T) => number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [project, rows] of Object.entries(tasks)) {
    if (!project) continue;
    for (const row of rows) out[project] = Math.max(out[project] ?? 0, lastActivity(row));
  }
  return out;
}

/** Anota la elección y descarta los ids que ya no existen. */
export function rememberPick(picked: Readonly<PickedAt>, id: string, now: number, existing: Iterable<string>): PickedAt {
  const out: PickedAt = {};
  for (const known of existing) {
    const at = picked[known];
    if (typeof at === "number" && Number.isFinite(at)) out[known] = at;
  }
  if (id) out[id] = now;
  return out;
}
