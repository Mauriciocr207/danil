import Eye from "lucide-solid/icons/eye";
import Plus from "lucide-solid/icons/plus";
import { type Component, createSignal, For, lazy, Show, Suspense } from "solid-js";
import { Dynamic } from "solid-js/web";
import { t } from "../../lib/i18n";
import { capabilities } from "../../lib/platform";
import { cn } from "../../lib/utils";
import { ITEM_DE_MENU, Popover, PopoverContent, PopoverTrigger } from "../../ui/Popover";
import { type AttentionState, type TaskAttention, topState } from "./attention";
import { matchesName } from "./hidden-workspaces";
import WorkspaceSearch, { SEARCH_FROM } from "./WorkspaceSearch";

const WorkspaceDirectoryMenu = lazy(() => import("./WorkspaceDirectoryMenu"));

/** Flechas arriba y abajo entre las filas de un menú; el buscador cuenta como la primera. */
export function menuArrows(e: KeyboardEvent) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const menu = e.currentTarget as HTMLElement;
  const items = [...menu.querySelectorAll<HTMLElement>('input[type="search"], [role="menuitem"]:not(:disabled)')];
  if (!items.length) return;
  e.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const step = e.key === "ArrowDown" ? 1 : -1;
  items[at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length]?.focus();
}

type Hidden = { id: string; name: string };

/** El «+» del riel: crear uno nuevo y, debajo, los ocultos para abrirlos o devolverlos a la barra. */
export default function AddWorkspaceMenu(props: {
  hidden: Hidden[];
  open: string | null;
  tasksOf: (id: string) => TaskAttention[];
  badge: Component<{ state: AttentionState; class?: string }>;
  /** Cómo se dice un estado junto al nombre, para quien no ve el distintivo. */
  labelOf: (state: AttentionState) => string;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onShow: (id: string) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [step, setStep] = createSignal<"menu" | "directory">("menu");
  const [query, setQuery] = createSignal("");
  const close = () => {
    setOpen(false);
    setStep("menu");
    setQuery("");
  };
  const rows = () => props.hidden.filter((w) => matchesName(w.name, query()));
  // El abierto ya enseña su distintivo en su cuadro.
  const waiting = () => topState(props.hidden.filter((w) => w.id !== props.open).flatMap((w) => props.tasksOf(w.id)));
  return (
    <Popover
      open={open()}
      onOpenChange={(value) => (value ? setOpen(true) : close())}
      placement="right-start"
      gutter={4}
    >
      <PopoverTrigger
        type="button"
        data-add-workspace=""
        data-attention={waiting() ?? undefined}
        class="relative mt-1 grid size-8 shrink-0 place-items-center rounded-md border border-dashed border-neutral-500 text-neutral-500 outline-none hover:bg-neutral-200 hover:text-neutral-950 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        aria-label={waiting() ? t("shell.workspaces.tile_with_state", { name: t("shell.workspaces.add"), state: props.labelOf(waiting() as AttentionState) }) : t("shell.workspaces.add")}
        title={t("shell.workspaces.add")}
      >
        <Plus size={16} aria-hidden="true" />
        <Show when={waiting()}>{(s) => <Dynamic component={props.badge} state={s()} class="absolute -top-1 -right-1" />}</Show>
      </PopoverTrigger>
      <PopoverContent role={step() === "menu" ? "menu" : undefined} class="w-64 p-1" onKeyDown={menuArrows}>
        <Show
          when={step() === "menu"}
          fallback={
            <Suspense fallback={null}>
              <WorkspaceDirectoryMenu onClose={close} />
            </Suspense>
          }
        >
          <button
            type="button"
            role="menuitem"
            class={ITEM_DE_MENU}
            onClick={() => {
              close();
              props.onCreate();
            }}
          >
            {t("shell.workspaces.create")}
          </button>
          <Show when={capabilities().workspaceDirectory}>
            <button type="button" role="menuitem" class={ITEM_DE_MENU} onClick={() => setStep("directory")}>
              {t("shell.workspaces.add_existing")}
            </button>
          </Show>
          <Show when={props.hidden.length > 0}>
            <span aria-hidden="true" class="mx-2 my-1 block h-px bg-border" />
            <p class="m-0 px-2 pt-1 pb-1 text-caption font-medium text-neutral-500">{t("shell.workspaces.hidden_title")}</p>
            <Show when={props.hidden.length >= SEARCH_FROM}>
              <WorkspaceSearch value={query()} onInput={setQuery} />
            </Show>
            <div class="max-h-64 overflow-y-auto" data-hidden-workspaces="">
              <For each={rows()}>
                {(w) => {
                  const state = () => (w.id === props.open ? null : topState(props.tasksOf(w.id)));
                  const name = () => w.name || t("shell.directory.unnamed");
                  return (
                    <div class="flex items-center gap-0.5" data-hidden-workspace={w.id}>
                      <button
                        type="button"
                        role="menuitem"
                        class={cn(ITEM_DE_MENU, "flex min-w-0 flex-1 items-center gap-2")}
                        aria-label={state() ? t("shell.workspaces.tile_with_state", { name: name(), state: props.labelOf(state() as AttentionState) }) : name()}
                        title={name()}
                        onClick={() => {
                          close();
                          props.onOpen(w.id);
                        }}
                      >
                        <span class="min-w-0 flex-1 truncate">{name()}</span>
                        <Show when={state()}>{(s) => <Dynamic component={props.badge} state={s()} />}</Show>
                      </button>
                      <button
                        type="button"
                        class="grid size-7 shrink-0 place-items-center rounded-sm text-neutral-500 outline-none hover:bg-neutral-200 hover:text-neutral-950 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-primary"
                        aria-label={t("shell.workspaces.show", { name: name() })}
                        title={t("shell.workspaces.show", { name: name() })}
                        data-show-workspace={w.id}
                        onClick={() => props.onShow(w.id)}
                      >
                        <Eye size={13} aria-hidden="true" />
                      </button>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </Show>
      </PopoverContent>
    </Popover>
  );
}
