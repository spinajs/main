# Generic throttle with pluggable stores — design

Follows `2026-10-14-memory-throttle-refactor-design.md`, which is already on branch `authz/memory-throttle`: `KeyedBackoff` in util, `FlowLimiter` per flow, `authn.throttle.memory.*`.

User decisions (2026-10-14):

- The whole throttle is generic and lives in `@spinajs/util`. authn only configures it, through a small subclass.
- Storage is pluggable through a `ThrottleStore`. Rebuild memory and DB on it now. Redis and other stores come later and only implement `ThrottleStore`.

## 1. `@spinajs/util`: `Throttle` decides, `ThrottleStore` keeps rows

New file `packages/util/src/resilience/throttle.ts`, exported from the resilience index.

```ts
export interface ThrottleKey { readonly kind: string; readonly value: string }

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

export interface ThrottleGate { readonly id: string; readonly backoff: BackoffParams }

export interface ThrottleLower { readonly targets: readonly ThrottleGate[]; readonly by: readonly string[] }

export interface ThrottleStore {
  /** Atomic per call: refuse with the longest running delay among `gates`, else count every gate and every `counted` id. */
  attempt(flow: string, gates: readonly ThrottleGate[], counted: readonly string[], nowMs: number): Promise<KeyedBackoffVerdict>;
  /** The same delay check, counting nothing. */
  peek(flow: string, gates: readonly ThrottleGate[], nowMs: number): Promise<KeyedBackoffVerdict>;
  /** One call per success: applied without interleaving where the store can (memory), otherwise per row with compare-and-set, where a lost race only throttles more. Each `lower` rule in order: consumes its `by` rows and lowers each target by the largest count among them, or by less where the store can tell a `by` row predates the target (memory run filter); a target at 0 is deleted, otherwise its delay is recomputed from its last attempt with its backoff. Then deletes the `clear` rows and ends a store's full-table refusal for that flow, where it has one. */
  succeed(flow: string, lower: readonly ThrottleLower[], clear: readonly string[], nowMs: number): Promise<void>;
}

export interface ThrottleOptions {
  readonly flows: Readonly<Record<string, ThrottleFlowRules>>;
  readonly store: ThrottleStore;
  /** Default `${flow}|${kind}|${value}`; util stays platform-neutral, so a caller that must not keep raw keys hashes here. */
  readonly keyId?: (flow: string, key: ThrottleKey) => string;
}

export class Throttle {
  constructor(options: ThrottleOptions);
  attempt(keys: readonly ThrottleKey[], flow: string, nowMs: number): Promise<KeyedBackoffVerdict>;
  peek(keys: readonly ThrottleKey[], flow: string, nowMs: number): Promise<KeyedBackoffVerdict>;
  succeed(keys: readonly ThrottleKey[], flow: string, nowMs: number): Promise<void>;
}
```

The `Throttle` itself does the following, with no storage logic:

- **Validation.** An unknown flow, a key value that is not a string, or a non-finite `nowMs` throws `InvalidArgument`. All of this happens before the store is called.
- **Turning keys into ids.** Each key becomes `keyId(flow, key)`. Ids are de-duplicated; when an id is both gating and counted, the gate wins.
- **`attempt` / `peek`.** Keys whose kind is in `gates` become gates. On `attempt` only, kinds in `counted` become counted ids. Every other kind is ignored.
- **`succeed`.** It makes exactly one `store.succeed` call per success. The memory store applies it without interleaving; the DB store applies it as several compare-and-set statements, not one transaction, as today. The call carries every `lower` rule in order, then the ids of the `clear` kinds. A rule is skipped when neither its `kind` nor its `by` matches a key. The call is made even with empty lists, because it also ends a full-table refusal. A flow without `onSuccess` makes no call.

## 2. `MemoryThrottleStore` (util)

New file `packages/util/src/resilience/memory-throttle-store.ts`. It keeps one `KeyedBackoff` per flow and keeps the current memory behaviour exactly:

- **One table per flow.** Each flow's limiter is built lazily through `limiter(flow, options)`, which defaults to `new KeyedBackoff`. It is cached, and each instance is checked: it must be a `KeyedBackoff`, and no other flow may already use it. Otherwise `InvalidOperation`. This replaces the check that now sits in `MemoryAuthnThrottle`.
  - On the first call for any flow, all flows the store knows are built. They are passed in as `flows: readonly string[]`.
- **Sweeping.** `attempt` sweeps the other flows with `ceil(sweepBatch / 4)`; the attempt's own flow sweeps inside `KeyedBackoff.attempt`.
- **`succeed`.** Applies each lower rule through `KeyedBackoff.lower`: rows compared by run, then the largest count. The `by` rows are deleted. Then it calls `release()` and deletes the `clear` rows.
- **Options:** `{ flows, maxRows, resetAfterMs, sweepBatch?, fullRetryMs?, holdOffMs?, delay?, onFull?: (flow) => void, limiter? }`.
- Each method has no `await` inside, so a single call is atomic.

## 3. authn: `StoreAuthnThrottle` and two small subclasses

New file `packages/authn/src/throttle/store-throttle.ts`, an abstract class:

```ts
export abstract class StoreAuthnThrottle extends AuthnThrottle implements PeekableThrottle {
  /** Flow rules from ThrottleParams, the same for every store. */
  protected rules(params: ThrottleParams): Record<ThrottleFlow, ThrottleFlowRules>;
  protected abstract params: ThrottleParams;            // config read once, frozen
  protected abstract store(): Promise<ThrottleStore>;   // built lazily
  protected abstract keyId(flow: string, key: ThrottleKey): string;  // HMAC; the secret differs per subclass
  // attempt/peek/succeed: ctx.now (or Date.now() for succeed, as today) -> nowMs, then delegate to a cached Throttle
}
```

The flow rules match today's behaviour in both throttles:

- **`login`, `mfa` and `reauth`:**
  - gates: `account` and `ip` from the flow's params, plus `global` when `params.global` is set;
  - `counted: ['account-ip']` when the flow has `ip` params (reset included);
  - `onSuccess: { lower: [{ kind: 'ip', by: 'account-ip' }] (only when the flow has ip params), clear: ['account', 'account-ip'] }`.
- **`reset`:** the same gates; no `onSuccess`, so a success clears nothing (§22.13).

**`MemoryAuthnThrottle extends StoreAuthnThrottle`:**

- `@Singleton @Injectable(AuthnThrottle)`.
- Its store is a `MemoryThrottleStore` with `limiter = (flow, o) => DI.resolve(FlowLimiter, [flow, o])`. `FlowLimiter` keeps its JSDoc rule: a subclass with its own DI decorators must also declare `@NewInstance()`.
- `onFull` logs the warning through `Log`.
- `keyId` is HMAC with a random secret per instance (D7).
- It keeps the protected `delayMs` seam (passed as `delay`) and a protected `limiter(flow)` for tests.
- It keeps the `explicit` params and the `options.maxRows` / `sweepBatch` overrides that tests use.

**`DbAuthnThrottle extends StoreAuthnThrottle`** (authn-orm):

- Its store is a new `DbThrottleStore implements ThrottleStore` in `packages/authn-orm/src/throttle/db-throttle-store.ts`. It holds today's DB logic unchanged:
  - claims by compare-and-set with undo, and live/stale reads;
  - the dialect handling and SQL-text times;
  - `blockedWait`, `countBook`, `takeBook` (consume) and `subtract` (lower);
  - `purge`.
- Its `succeed` subtracts the largest consumed `by` count without comparing runs, because DB rows carry no run. It is several compare-and-set statements, not one transaction; a lost race only throttles more. Today's DB behaviour stays.
- `DbAuthnThrottle` keeps:
  - `@Singleton @Injectable(AuthnThrottle)`;
  - `init()`, `purge()` and `checkConfiguration()`;
  - `rowKey`, which is its `keyId`: HMAC under `authn.audit.hashKey.secret`;
  - its public surface and its options.
- Its `attempt`, `peek` and `succeed` come from the base class.

authn-orm imports `StoreAuthnThrottle` from a subpath of `@spinajs/authn` (for example `./throttle`), or from the root entry, whichever the package exports already allow. The contracts boundary does not change.

## 4. Unchanged

- The `AuthnThrottle` contract and `PeekableThrottle`.
- Every caller.
- `selectAuthnThrottle`, which still picks by name: `MemoryAuthnThrottle` and `DbAuthnThrottle`.
- Config keys.
- Rows the DB already holds.

## 5. Tests

- **util `throttle.test.ts`**, with a recording fake store:
  - gates vs counted;
  - de-duplication, gate wins;
  - unknown kinds ignored;
  - `succeed` makes one store call (lower rules in order, then clear) and skips rules;
  - validation errors raised before the store is called.
- **util `memory-throttle-store.test.ts`:**
  - the per-flow limiter factory and its checks;
  - the sweep split;
  - `succeed`: lower, then clear, in one call with no interleaving;
  - parity cases moved over from authn.
- **authn:** `memory-throttle.test.ts` and the mutation suite stay green, with their seams moved to the subclass.
- **authn-orm:** `db-throttle.test.ts`, `throttle-config.test.ts`, `throttle-conformance.test.ts` and `throttle-dialects.test.ts` stay green on sqlite. The Postgres cases are skipped here, as today.
- **authn-testing:** the A05 and A06 behaviour specs run against both throttles and stay green.

## 6. Docs

- util `documentation/resilience.md`: sections for `Throttle` and `ThrottleStore`, and how to write a store (`attempt` that no two parallel attempts pass where only one may, `succeed` without interleaving or per row with compare-and-set, `lower` semantics), with Redis as the example.
- The authn throttle README covers only what is authn-specific: key kinds, the flow-rule table, A06/D8, config, DI, and choosing a store.
- Release notes.
