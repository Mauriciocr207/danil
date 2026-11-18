import { createSignal, type JSX, Show } from "solid-js";
import { t } from "../../lib/i18n";
import { capabilities } from "../../lib/platform";
import { ITEM_DE_MENU, Popover, PopoverAnchor, PopoverContent } from "../../ui/Popover";
import { RETARDO_TOOLTIP, TooltipContent, TooltipRoot, TooltipTrigger } from "../../ui/Tooltip";
import { cerrarConEscape as createEscapeCloser } from "../settings";

const monogram = (name: string) => name.trim().slice(0, 1).toUpperCase() || "?";
/** La cuenta de un grupo: la inicial de su organización o correo; su menú la quita o vuelve a entrar. */
export const AccountHeader = (p: { id: string; email: string | null; extra: boolean; signedIn: boolean; stale?: boolean; name?: string; initialName?: string; children?: JSX.Element; accounts?: ReturnType<typeof capabilities>["webAccounts"] }) => {
    const accounts = () => p.accounts;
    const [accountMenu, setAccountMenu] = createSignal<string | null>(null);
    createEscapeCloser(() => accountMenu() === p.id, () => setAccountMenu(null));
    const label = () => p.name ?? t("shell.workspaces.account", { email: p.email ?? "" });
    return (
      <Popover open={accountMenu() === p.id} onOpenChange={(open) => setAccountMenu(open ? p.id : null)} placement="right-start" gutter={4}>
        <PopoverAnchor class="w-full">
          <TooltipRoot openDelay={RETARDO_TOOLTIP} placement="right" gutter={6} disabled={accountMenu() === p.id}>
            <TooltipTrigger
              as="button"
              type="button"
              data-account-header={p.id}
              class="mt-2 mb-0.5 flex w-full items-center gap-1 px-3 text-left outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-primary"
              aria-label={label()}
              onClick={() => setAccountMenu(p.id)}
            >
              <span aria-hidden="true" class="grid size-4 shrink-0 place-items-center rounded-full bg-neutral-200 text-[0.5625rem] font-semibold text-neutral-700">
                {monogram(p.initialName ?? p.email ?? "?").slice(0, 1)}
              </span>
              <span aria-hidden="true" class="h-px flex-1 bg-border" />
            </TooltipTrigger>
            <TooltipContent>{p.name ?? p.email}</TooltipContent>
          </TooltipRoot>
        </PopoverAnchor>
        <PopoverContent role="menu" class="w-64 p-1">
          <p class="m-0 truncate px-2 pt-1 pb-1 text-caption font-medium text-neutral-500">{p.email}</p>
          {p.children}
          <Show when={p.stale && p.signedIn}>
            <p class="m-0 px-2 pb-1 text-caption text-neutral-500">{t("shell.workspaces.stale")}</p>
          </Show>
          <Show when={!p.signedIn}>
            <button role="menuitem" class={ITEM_DE_MENU} onClick={() => (setAccountMenu(null), accounts()?.add(p.email))}>
              {t("shell.workspaces.sign_in_again")}
            </button>
          </Show>
          <Show when={p.extra}>
            <button
              role="menuitem"
              class={ITEM_DE_MENU}
              onClick={() => {
                setAccountMenu(null);
                if (window.confirm(t("shell.workspaces.remove_confirm", { email: p.email ?? "" }))) void accounts()?.remove(p.id);
              }}
            >
              {t("shell.workspaces.remove_account")}
            </button>
          </Show>
        </PopoverContent>
      </Popover>
    );
  };

