import type { ResourceType } from './principal.js';

/** The kinds of authz state the changelog records (G15). `column`: a relation column of an access resource row. */
export const CHANGE_KINDS = Object.freeze(['tuple', 'assignment', 'membership', 'rule', 'policy', 'attribute', 'column'] as const);

export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** `put` replaces what the key held, `add` and `remove` create and delete it. */
export type ChangeOp = 'add' | 'remove' | 'put';

/** One change a store write made, as the store appends it. */
export interface ChangeEntry {
  readonly kind: ChangeKind;
  readonly op: ChangeOp;
  /** The changed item, unique within its kind: a tuple key, an assignment or rule id, `type:id#relation` for a column. */
  readonly key: string;
  /** JSON-serialisable state after the change (or what was removed). */
  readonly payload?: unknown;
  /** JSON-serialisable state the change replaced, when the store knows it. */
  readonly before?: unknown;
  /** `principalKey` of who made the change; the current principal when absent. */
  readonly actor?: string;
  /** The instant of the change; now when absent. */
  readonly at?: Date;
}

/** A stored change; `seq` orders changes, `at` may repeat. */
export interface ChangeRecord {
  readonly seq: number;
  readonly at: Date;
  readonly kind: ChangeKind;
  readonly op: ChangeOp;
  readonly key: string;
  readonly payload: unknown;
  /** null when the store logged none. */
  readonly before: unknown;
  readonly actor: string | null;
  readonly traceId: string | null;
}

export interface ChangeQuery {
  readonly kinds?: readonly ChangeKind[];
  /** Only changes with a `seq` above this one: the last `seq` of the previous page. */
  readonly after?: number;
  /** Default 1000, at most 10000. */
  readonly limit?: number;
}

/**
 * Append-only history of authz state (G15), written in the transaction of the store write it records.
 * A store that is not backed by the log's database appends nothing, and `covers` reports its kind as
 * uncovered: replay then names that kind as missing instead of guessing from current state.
 */
export abstract class ChangeLog {
  /** Every write of `kind` lands here. For `column`, `resourceType` narrows the answer to that type's models. */
  abstract covers(kind: ChangeKind, resourceType?: ResourceType): boolean;
  /** A store backed by this log's database declares the kind it writes, once it exists. */
  abstract track(kind: ChangeKind): void;
  abstract append(entries: readonly ChangeEntry[]): Promise<void>;
  /** Changes after `seq`, in `seq` order. */
  abstract since(seq: number, query?: ChangeQuery): Promise<readonly ChangeRecord[]>;
  /** Changes at or before `at`, in `seq` order. */
  abstract until(at: Date, query?: ChangeQuery): Promise<readonly ChangeRecord[]>;
  /** Changes whose `at` is after the instant, in `seq` order (`afterInstant`, not `after`: `ChangeQuery.after` is a seq). */
  abstract afterInstant(at: Date, query?: ChangeQuery): Promise<readonly ChangeRecord[]>;
  /** For each key, its last change at or before `at`; without `at`, its last change. Keys without one are absent. */
  abstract latest(kind: ChangeKind, keys: readonly string[], at?: Date): Promise<ReadonlyMap<string, ChangeRecord>>;
  /**
   * From when every write of `kind` (of `resourceType`, for `column`) up to now is in the log, as recorded by the app's
   * boots; undefined when never covered. Independent of the calling process.
   */
  abstract coveredSince(kind: ChangeKind, resourceType?: ResourceType): Promise<Date | undefined>;
  /** A write of `kind` escaped the log just now: coverage restarts now. `column` without a type: of every type. */
  abstract lost(kind: ChangeKind, resourceType?: ResourceType, reason?: string): Promise<void>;
}

/** The log of an app without a changelog store: records nothing, covers nothing. */
export class NoChangeLog extends ChangeLog {
  covers(_kind: ChangeKind, _resourceType?: ResourceType): boolean {
    return false;
  }

  track(_kind: ChangeKind): void {}

  async append(_entries: readonly ChangeEntry[]): Promise<void> {}

  async since(_seq: number, _query?: ChangeQuery): Promise<readonly ChangeRecord[]> {
    return [];
  }

  async until(_at: Date, _query?: ChangeQuery): Promise<readonly ChangeRecord[]> {
    return [];
  }

  async afterInstant(_at: Date, _query?: ChangeQuery): Promise<readonly ChangeRecord[]> {
    return [];
  }

  async latest(_kind: ChangeKind, _keys: readonly string[], _at?: Date): Promise<ReadonlyMap<string, ChangeRecord>> {
    return new Map();
  }

  async coveredSince(_kind: ChangeKind, _resourceType?: ResourceType): Promise<Date | undefined> {
    return undefined;
  }

  async lost(_kind: ChangeKind, _resourceType?: ResourceType, _reason?: string): Promise<void> {}
}
