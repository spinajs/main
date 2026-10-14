import { InvalidArgument } from '@spinajs/exceptions';

import type { BackoffParams, KeyedBackoffVerdict } from './keyed-backoff.js';

export interface ThrottleKey {
  readonly kind: string;
  readonly value: string;
}

/** What one flow does with each key kind. Kinds the rules do not name are ignored. */
export interface ThrottleFlowRules {
  /** Kinds that gate in this flow, each with its backoff. */
  readonly gates: Readonly<Record<string, BackoffParams>>;
  /** Kinds counted without gating (bookkeeping for `lower`). */
  readonly counted?: readonly string[];
  readonly onSuccess?: {
    /** Lower each `kind` row by the attempts the `by` rows counted; the `by` rows are consumed (deleted). */
    readonly lower?: readonly { readonly kind: string; readonly by: string }[];
    /** Kinds whose rows a success deletes (after `lower`). */
    readonly clear?: readonly string[];
  };
}

export interface ThrottleGate {
  readonly id: string;
  readonly backoff: BackoffParams;
}

/**
 * Keeps the throttle's rows; `Throttle` decides which ids to pass. Ids are opaque. Each call must be atomic on its own:
 * parallel `attempt`s of one gate must not both pass a check that only one of them may pass.
 */
export interface ThrottleStore {
  /** Atomic per call: refuse with the longest running delay among `gates`, else count every gate and every `counted` id. */
  attempt(flow: string, gates: readonly ThrottleGate[], counted: readonly string[], nowMs: number): Promise<KeyedBackoffVerdict>;
  /** The same delay check, counting nothing. */
  peek(flow: string, gates: readonly ThrottleGate[], nowMs: number): Promise<KeyedBackoffVerdict>;
  /** Success: consumes the `by` rows and lowers each target by the largest count among them; a target at 0 is deleted, otherwise its delay is recomputed from its last attempt with its backoff. */
  lower(flow: string, targets: readonly ThrottleGate[], by: readonly string[], nowMs: number): Promise<void>;
  /** Success: deletes rows; also ends a store's full-table refusal for that flow, where it has one. */
  clear(flow: string, ids: readonly string[], nowMs: number): Promise<void>;
}

export interface ThrottleOptions {
  readonly flows: Readonly<Record<string, ThrottleFlowRules>>;
  readonly store: ThrottleStore;
  /** Default `${flow}|${kind}|${value}`; util stays platform-neutral, so a caller that must not keep raw keys hashes here. */
  readonly keyId?: (flow: string, key: ThrottleKey) => string;
}

const own = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

const defaultKeyId = (flow: string, key: ThrottleKey): string => `${flow}|${key.kind}|${key.value}`;

/**
 * Per-key backoff over pluggable storage: the flow rules turn keys into gates and counted ids, the `ThrottleStore`
 * keeps the rows. It never locks a key: a key only waits longer.
 *
 * Every argument is checked before the store is called. Only the keys an operation uses are checked and keyed:
 * a kind the flow ignores may carry anything.
 */
export class Throttle {
  private readonly flows: Readonly<Record<string, ThrottleFlowRules>>;
  private readonly store: ThrottleStore;
  private readonly keyId: (flow: string, key: ThrottleKey) => string;

  constructor(options: ThrottleOptions) {
    for (const [flow, rules] of Object.entries(options.flows)) {
      for (const { kind } of rules.onSuccess?.lower ?? []) {
        if (!own(rules.gates, kind)) throw new InvalidArgument(`Throttle: flow ${JSON.stringify(flow)} lowers ${JSON.stringify(kind)}, which it does not gate`);
      }
    }
    this.flows = options.flows;
    this.store = options.store;
    this.keyId = options.keyId ?? defaultKeyId;
  }

  /** Refuses with the longest running delay among the gating keys; otherwise counts the gating and counted keys. */
  async attempt(keys: readonly ThrottleKey[], flow: string, nowMs: number): Promise<KeyedBackoffVerdict> {
    const rules = this.rules(flow, nowMs);
    const gates = this.gates(keys, flow, rules);
    const gating = new Set(gates.map((g) => g.id));
    const counted = this.ids(keys, flow, rules.counted ?? []).filter((id) => !gating.has(id));
    return this.store.attempt(flow, gates, counted, nowMs);
  }

  /** Refuses as `attempt` would for a delay, counting nothing. */
  async peek(keys: readonly ThrottleKey[], flow: string, nowMs: number): Promise<KeyedBackoffVerdict> {
    const rules = this.rules(flow, nowMs);
    return this.store.peek(flow, this.gates(keys, flow, rules), nowMs);
  }

  /** Runs the flow's `onSuccess`: every `lower` rule in order, then `clear`. */
  async succeed(keys: readonly ThrottleKey[], flow: string, nowMs: number): Promise<void> {
    const { gates, onSuccess } = this.rules(flow, nowMs);
    if (!onSuccess) return;
    const lowers = (onSuccess.lower ?? []).map(({ kind, by }) => ({
      targets: this.ids(keys, flow, [kind]).map((id) => ({ id, backoff: gates[kind] })),
      by: this.ids(keys, flow, [by]),
    }));
    const cleared = onSuccess.clear ? this.ids(keys, flow, onSuccess.clear) : undefined;

    for (const { targets, by } of lowers) {
      if (targets.length > 0 || by.length > 0) await this.store.lower(flow, targets, by, nowMs);
    }
    // Called even with no ids: clearing also ends a full-table refusal.
    if (cleared) await this.store.clear(flow, cleared, nowMs);
  }

  private rules(flow: string, nowMs: number): ThrottleFlowRules {
    if (typeof flow !== 'string' || !own(this.flows, flow)) throw new InvalidArgument(`Throttle: unknown flow ${JSON.stringify(String(flow))}`);
    if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) throw new InvalidArgument('Throttle: nowMs must be a finite number');
    return this.flows[flow];
  }

  private gates(keys: readonly ThrottleKey[], flow: string, rules: ThrottleFlowRules): ThrottleGate[] {
    const gates = new Map<string, BackoffParams>();
    for (const key of keys) {
      if (!own(rules.gates, key.kind)) continue;
      const id = this.id(flow, key);
      if (!gates.has(id)) gates.set(id, rules.gates[key.kind]);
    }
    return [...gates].map(([id, backoff]) => ({ id, backoff }));
  }

  /** De-duplicated ids of the keys of `kinds`, in key order. */
  private ids(keys: readonly ThrottleKey[], flow: string, kinds: readonly string[]): string[] {
    const ids = new Set<string>();
    for (const key of keys) if (kinds.includes(key.kind)) ids.add(this.id(flow, key));
    return [...ids];
  }

  private id(flow: string, key: ThrottleKey): string {
    if (typeof key.value !== 'string') throw new InvalidArgument(`Throttle: the value of a ${JSON.stringify(String(key.kind))} key must be a string`);
    return this.keyId(flow, key);
  }
}
