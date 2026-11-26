/** A row as a history stream holds it: column name to JSON value. */
export type RowImage = Readonly<Record<string, unknown>>;

/** `put` replaces what the key held, `add` and `remove` create and delete it. */
export type ReplayChangeOp = 'add' | 'remove' | 'put';

/**
 * One change of one key, as replay reads it from any history stream. `seq` orders the changes of one entity and is
 * unique within it only; `at` may repeat. `image` and `before` are null where the stream did not record them.
 */
export interface ReplayChange<I = RowImage> {
  readonly entity: string;
  readonly key: string;
  readonly op: ReplayChangeOp;
  /** The state after the change; for a `remove`, what was removed. */
  readonly image: I | null;
  /** The state the change replaced. */
  readonly before: I | null;
  readonly at: Date;
  readonly seq: number;
  readonly traceId: string | null;
}
