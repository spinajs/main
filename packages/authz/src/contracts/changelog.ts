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
}
