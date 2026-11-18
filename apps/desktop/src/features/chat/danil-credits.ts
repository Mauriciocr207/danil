import { DANIL_CREDITS_MODEL } from "../../../../../packages/tasks/src/danil-services.ts";

// El engine anuncia este modelo solo con una delegación vigente del pagador.
export const DANIL_CREDITS = Object.freeze({
  modelId: DANIL_CREDITS_MODEL,
  upstreamModelId: "deepseek/deepseek-v4.1-flash",
} as const);

/** El saldo ya validado para el contexto de la ventana. */
export type DanilCreditsSource = {
  readBalance: (signal: AbortSignal) => Promise<number | null>;
  prepare?: (headers: Record<string, string>) => Promise<unknown>;
  subscribe?: (clear: () => void) => () => void;
  /** Abre la recarga en el navegador para la cuenta autenticada; sin ella no se ofrece. */
  recharge?: () => Promise<void>;
};

/** Proyección del saldo de Treasury para la organización del workspace activo. */
export function availableDanilCredits(value: unknown, organizationId: string): number | null {
  if (!value || typeof value !== "object") return null;
  const { organization_id, available } = value as { organization_id?: unknown; available?: unknown };
  if (organization_id !== organizationId || !available || typeof available !== "object") return null;
  const { currency, amount_micro } = available as { currency?: unknown; amount_micro?: unknown };
  if (currency !== "MXN" || typeof amount_micro !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(amount_micro)) return null;
  if (BigInt(amount_micro) > 9223372036854775807n) return null;
  return Number(amount_micro) / 1_000_000;
}
