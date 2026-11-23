import type { Constructor } from '@spinajs/di';
import type { ModelBase } from '@spinajs/orm';

export type HistoryOp = 'insert' | 'update' | 'delete' | 'soft_delete' | 'restore' | 'lost';

/** A view over a StoredAuditEvent of kind 'data'. */
export interface HistoryEntry {
  readonly seq: number;
  readonly at: Date;
  readonly entity: string;
  readonly id: string;
  readonly op: HistoryOp;
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>> | null;
  readonly changed: readonly string[];
  readonly actor: string;
  /** The person acting through `actor` when impersonating, else null. */
  readonly onBehalfOf: string | null;
  readonly traceId: string | null;
  /** True after `forget`: `before`, `after` and `changed` are gone, everything else stays. */
  readonly redacted: boolean;
}

export interface HistoryQuery {
  /** Only entries with a `seq` above this one: the last `seq` of the previous page. */
  readonly afterSeq?: number;
  /** Default 100, at most 1000. */
  readonly limit?: number;
  readonly ops?: readonly HistoryOp[];
  readonly from?: Date;
  readonly to?: Date;
  /** Keep the entries that changed at least one of these columns; inserts and deletes list none and never match. */
  readonly changed?: readonly string[];
}

export type AsOf =
  | { readonly state: 'present'; readonly row: Readonly<Record<string, unknown>>; readonly seq: number }
  | { readonly state: 'absent'; readonly seq: number | null }
  | { readonly state: 'redacted'; readonly seq: number }
  | { readonly state: 'unknown' };

/** What `Model.history()` returns on a marked model, and `historyOf(Model)` on any tracked one. */
export interface ModelHistory {
  of(id: string | number | bigint, query?: HistoryQuery): Promise<readonly HistoryEntry[]>;
  asOf(id: string | number | bigint, at: Date): Promise<AsOf>;
  since(seq: number, query?: HistoryQuery): Promise<readonly HistoryEntry[]>;
  /** Row changes of this model made by `actor` (a principal key as the trail stores it, `user:42`), by `seq`. */
  byActor(actor: string, query?: HistoryQuery): Promise<readonly HistoryEntry[]>;
  forget(id: string | number | bigint): Promise<number>;
}

/** What `row.history()` and `historyOf(row)` return: the history of one row, bound to its primary key. */
export interface RowHistory {
  /** This row's entries, oldest first; same filters and limits as `Model.history().of(id, query)`. */
  entries(query?: HistoryQuery): Promise<readonly HistoryEntry[]>;
  asOf(at: Date): Promise<AsOf>;
  forget(): Promise<number>;
}

/** The static member a model marked with `@History()` declares: `declare static history: TrackedModel['history'];` */
export interface TrackedModel {
  history(): ModelHistory;
}

/** The instance member it declares: `declare history: TrackedRow['history'];` */
export interface TrackedRow {
  history(): RowHistory;
}

/** Implemented by `read.ts` (Task 6); the members `@History()` installs on a model, and `historyOf`, forward to it. */
export abstract class ModelHistorySource {
  abstract of(model: Constructor<ModelBase>): ModelHistory;
  abstract ofRow(row: ModelBase): RowHistory;
}
