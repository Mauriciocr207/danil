import { Show, createMemo } from "solid-js";
import { t } from "../../lib/i18n";
import { formatearDuracion, type Paso } from "../../lib/steps";
import { createNow } from "../../lib/sharedClock";
import { MachineIcon } from "../machines/MachineIcon";
import type { MachineWait } from "../threads/store";
import { ActivityDots } from "./ActivityDots";

export type MachineWaitStatus = Pick<MachineWait, "phase"> & { name: string; wakes: boolean };

const MUESTRA_EL_RELOJ_DESDE_MS = 3000;

// La actividad normal usa puntos; los bloqueos conservan su estado explícito.
// Esperar una respuesta o reintentar sí sustituye el rótulo de trabajo.
export default function EstadoDelTurno(props: {
  /** El paso que está corriendo, si hay uno. */
  paso: Paso | null;
  /** El turno preguntó algo y no puede seguir sin respuesta. */
  esperando: boolean;
  /**
   * El CLI está reintentando contra su proveedor. `null` mientras no lo anuncie
   * —y en los agentes que no lo anuncian, que son todos menos Claude—.
   */
  reintento: { intento: number; total: number; clase: string } | null;
  /** El agente contestó y está libre; lo que sigue corriendo es una hija. */
  enFondo: boolean;
  /**
   * Cuándo arrancó el turno, en epoch ms. `null` cuando no se sabe —un turno
   * que esta ventana no vio arrancar— y entonces se cuenta desde aquí.
   */
  desde: number | null;
  /** El envío espera a que la máquina encienda o abra su canal. */
  machineWait?: MachineWaitStatus | null;
}) {
  // Medirlo desde el montaje es lo que ponía el reloj a cero en cada
  // remontaje: cambiar de workspace, de pestaña o de tarea y volver.
  const montado = Date.now();
  const desde = () => props.desde ?? montado;
  const ahora = createNow();

  const dice = createMemo(() => {
    if (props.machineWait) {
      const { phase, name } = props.machineWait;
      const verbo = phase === "connecting" ? t("chat.turn.connecting", { name }) : t("chat.turn.waking", { name });
      return { verbo, sujeto: null };
    }
    if (props.esperando)
      return { verbo: t("chat.turn.waiting_answer"), sujeto: null };
    if (props.enFondo)
      return { verbo: t("chat.turn.waiting_background"), sujeto: null };
    // **Un reintento no es un verbo de broma.** Mientras el proveedor no
    // contesta, el rótulo deja de jugar y dice qué pasa y por dónde va: es
    // exactamente cuando la espera empieza a parecer un cuelgue.
    const r = props.reintento;
    if (r)
      return {
        verbo: t("chat.turn.retrying", { attempt: r.intento, total: r.total }),
        sujeto: null,
      };
    return { verbo: t("chat.turn.working_aria"), sujeto: null };
  });

  // Los primeros segundos no llevan reloj: un «0s» que aparece con el turno es
  // ruido, y la duda aparece después. Con el agente parado no lleva reloj
  // ninguno: el número contesta «¿esto sigue vivo?» de quien trabaja, y sobre
  // una hija cuenta el turno entero del padre. Cuántas hijas trabajan lo dice
  // su sección del sidebar.
  const cuanto = () => {
    if (props.enFondo) return null;
    const ms = ahora() - desde();
    return ms >= MUESTRA_EL_RELOJ_DESDE_MS ? formatearDuracion(ms) : null;
  };

  return (
    <p
      class="m-0 flex items-start gap-2 text-neutral-500 italic"
      role="status"
      aria-live="polite"
      aria-label={
        props.machineWait
          ? dice().verbo
          : props.esperando
          ? t("chat.turn.waiting_answer")
          : props.reintento || props.enFondo
            ? dice().verbo
            : t("chat.turn.working_aria")
      }
    >
      <Show when={props.machineWait || props.esperando || props.reintento || props.enFondo} fallback={<><ActivityDots /><span class="sr-only">{t("chat.turn.working_aria")}</span></>}>
        <Show when={props.machineWait}>{(machine) => <MachineIcon wakes={machine().wakes} size={14} />}</Show>
        <span>{dice().verbo}</span>
      </Show>
      <Show when={cuanto()}>{(duration) => <span aria-hidden="true" class="text-xs tabular-nums">{duration()}</span>}</Show>
    </p>
  );
}
