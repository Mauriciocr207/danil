export type TurnActivity<Message> = {
  readonly key: string;
  readonly anchor: Message | null;
  readonly anchorIndex: number;
  readonly active: boolean;
  readonly startedAt: number | null;
  readonly durationMs: number | null;
  readonly messages: readonly Message[];
};
