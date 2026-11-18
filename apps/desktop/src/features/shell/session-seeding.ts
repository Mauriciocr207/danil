export function sessionSeedInputs(group: { workspaces?: "all" | "later" } | undefined, available: readonly { id: string }[] | null, shown: ReadonlySet<string>, hidden: ReadonlySet<string>) {
  return group?.workspaces === "all" ? { shown: new Set((available ?? []).map((w) => w.id)), hidden: new Set<string>() } : { shown, hidden };
}
