import type { ChangeKind, ResourceType } from '@spinajs/authz';

/**
 * One recorded change of a key, as the replay reads it. Declared here so the replay names no history store: whoever
 * loads the history decides where its changes come from.
 */
export interface ReplayChange {
  /** Orders the changes of one key; `at` may repeat. The replay never compares the `seq` of two keys. */
  readonly seq: number;
  readonly at: Date;
  readonly kind: ChangeKind;
  /** `put` replaces what the key held, `add` and `remove` create and delete it. */
  readonly op: 'add' | 'remove' | 'put';
  /** The changed item, unique within its kind. */
  readonly key: string;
  /** The JSON state after the change, or what was removed. */
  readonly payload: unknown;
  /** The JSON state the change replaced; null when none was recorded. */
  readonly before: unknown;
  readonly traceId: string | null;
}

export type KeyState =
  | { readonly known: true; readonly value: unknown; readonly origin: 'current' | 'history'; readonly seq?: number }
  | { readonly known: false; readonly reason: string };

/** Changes inside `[T - beforeMs, T + afterMs]` may be on either side of the decision. */
export interface ReplayWindow {
  readonly beforeMs: number;
  readonly afterMs: number;
}

export interface KeyInput {
  kind: ChangeKind;
  /** The store's row projected to the payload shape, or undefined when the key is absent now. */
  current: unknown;
  /** The key's changes with `at` after T, in `seq` order. */
  after: readonly ReplayChange[];
  /** The key's last change with `at` at or before T, if retained. */
  before?: ReplayChange;
  /** `coveredSince` of the kind (and type), read after the key's history. */
  since?: Date;
  window: ReplayWindow;
  /**
   * Precision of the instants inside images, that of the coarsest store column they come from; default 1 ms. The
   * changelog's `changeLogPrecisionMs` serves only while every such column keeps at least that precision: a coarser
   * one turns healthy keys into gaps.
   */
  precisionMs?: number;
}

export interface ReplayHistoryLimits {
  maxChanges: number;
  maxKeys: number;
  window: ReplayWindow;
  /**
   * One precision for every key of the history: that of the coarsest store column any contributor's images take
   * instants from; default 1 ms. `changeLogPrecisionMs` serves while every such column keeps the changelog's precision.
   */
  precisionMs?: number;
  /** The reader's clock, which catch-up passes overlap from; default `Date.now`. */
  now?: () => number;
}

/**
 * The history of one replay from the backward edge of the decision's window on: one scan at load, then lookups per
 * key. Callers read in this order: scan, current rows, `catchUp`, `headOf`, `beforeOf`, and `since` last.
 */
export interface ReplayHistoryView {
  readonly at: Date;
  /** The kinds the scan covers. */
  readonly kinds: readonly ChangeKind[];
  readonly window: ReplayWindow;
  readonly precisionMs: number;
  /** Changes scanned so far. */
  readonly changes: number;
  /** Distinct keys resolved so far. */
  readonly keys: number;
  /** The key's scanned changes in `seq` order; those at or before T lie inside the window, which makes the key a gap. */
  afterFor(kind: ChangeKind, key: string): readonly ReplayChange[];
  changesOf(kind: ChangeKind): Iterable<ReplayChange>;
  /** Scans what was committed since the previous pass, so a write that landed during the replay is seen. */
  catchUp(): Promise<void>;
  /** Each key's last change at or before T. */
  beforeOf(kind: ChangeKind, keys: readonly string[]): Promise<ReadonlyMap<string, ReplayChange>>;
  /** Each key's last change, whenever it happened; the keys count against `maxKeys` here. */
  headOf(kind: ChangeKind, keys: readonly string[]): Promise<ReadonlyMap<string, ReplayChange>>;
  /** Counts keys against `maxKeys` before anything is read for them. */
  reserve(kind: ChangeKind, keys: readonly string[]): void;
  /** From when every write of the kind (of `type`, for `column`) is in the history. Read after the history it vouches for. */
  since(kind: ChangeKind, type?: ResourceType): Promise<Date | undefined>;
}

/** Loads the history view of one replay. Past `maxChanges` or `maxKeys` the view throws an error `replayBudgetStop` reads. */
export type ReplayHistoryLoader = (at: Date, kinds: readonly ChangeKind[], limits: ReplayHistoryLimits, signal?: AbortSignal) => Promise<ReplayHistoryView>;

/** The rules that turn one key's current state and its changes into its state at an instant. */
export interface KeyStateFunctions {
  /** The state of one key at `t`, or a gap naming why it cannot be told. */
  stateAt: (t: Date, k: KeyInput) => KeyState;
  /** Why the history of `kind` cannot vouch for `t`, or undefined when it covers it. */
  coverageGap: (t: Date, kind: ChangeKind, since: Date | undefined, window: ReplayWindow) => string | undefined;
  /** Equality of two JSON images, instants compared at `precisionMs`. */
  sameImage: (a: unknown, b: unknown, precisionMs?: number) => boolean;
}

/** What a replay needs of a history, whatever stores it. */
export interface ReplayHistoryPorts {
  history: ReplayHistoryLoader;
  keyState: KeyStateFunctions;
}

export interface ReplayBudgetStop {
  readonly limit: 'maxChanges' | 'maxKeys';
  readonly count: number;
}

/**
 * The budget a thrown error reports, or undefined for any other error. Read by shape, not by class: the history view
 * may come from a package this one does not import.
 */
export function replayBudgetStop(e: unknown): ReplayBudgetStop | undefined {
  if (!(e instanceof Error) || !('limit' in e) || !('count' in e)) return undefined;
  const { limit, count } = e;
  return (limit === 'maxChanges' || limit === 'maxKeys') && typeof count === 'number' ? { limit, count } : undefined;
}
