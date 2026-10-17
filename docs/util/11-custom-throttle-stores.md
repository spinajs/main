# Custom throttle stores

`ThrottleStore` is the storage interface behind [`Throttle`](10-throttle.md). Implement it to share throttle rows between app instances (Redis, DynamoDB, SQL), or customize the in-memory store through its per-flow `limiter` factory. `Throttle` decides which ids gate and which are counted; the store only keeps rows and applies the arithmetic.

## How it works

`Throttle` calls three methods. Ids are opaque strings; the store never sees key kinds.

| Method | Called by | Must do |
| --- | --- | --- |
| `attempt(flow, gates, counted, nowMs)` | `Throttle.attempt` | Atomically: if any gate's row has a running delay, return `{ allowed: false, retryAfterSeconds }` with the longest remaining wait (at least 1) and count nothing. Otherwise count every gate (attempt `n + 1`, next allowed time `nowMs + backoffDelayMs(backoff, n + 1)`) and every `counted` id, and return `{ allowed: true }` |
| `peek(flow, gates, nowMs)` | `Throttle.peek` | The same delay check, counting nothing |
| `succeed(flow, lower, clear, nowMs)` | `Throttle.succeed`, once per success | For each `lower` rule in order: consume (delete) its `by` rows, lower each target by the **largest** count among them; a target at 0 is deleted, otherwise its delay is recomputed from its last attempt with its own backoff. Then delete the `clear` rows and end any full-table refusal for that flow |

`ThrottleGate` is `{ id, backoff: BackoffParams }`; `ThrottleLower` is `{ targets: ThrottleGate[], by: string[] }`.

### The contract in detail

- **Atomicity.** Two parallel attempts must not both pass a check only one may pass: of N parallel attempts on a fresh key exactly `free` pass, then one per delay slot. A store may only err towards more throttling.
- **No locking.** A key never becomes permanently blocked; it only waits longer.
- **Flows.** Ids are unique per flow when the caller's `keyId` includes the flow (the default does), so a store may ignore the `flow` argument, as `DbThrottleStore` does. A store that shares one keyspace across flows with a custom `keyId` must namespace by `flow`.
- **Expiry.** A row with no counted attempt for `resetAfter` and no running delay is as good as absent, and the store may purge it. A running delay is never cut short by idle time. `resetAfter` is the store's own setting and must match the throttle's decay (`authn.throttle.resetAfterSeconds` in authn).
- **`succeed` without interleaving.** Apply it in one step where the store can (memory, a Lua script). Otherwise go row by row with compare-and-set: a lost race must only leave a row higher, never lower.
- **`lower` and runs.** A store that can tell a `by` row began after its target (`MemoryThrottleStore` compares runs) subtracts only those rows; one that cannot (`DbThrottleStore`) subtracts the largest count it consumed.
- **Capacity** is the store's business. `MemoryThrottleStore` evicts rows that delay nobody and refuses attempts that need a new row when none can go; a database store can leave it to the database.

### Shipped implementations

| Store | Package | Scope | Atomicity |
| --- | --- | --- | --- |
| `MemoryThrottleStore` | `@spinajs/util` | One process | No `await` inside a call; one `KeyedBackoff` per flow |
| `DbThrottleStore` | `@spinajs/authn-orm` | Every instance sharing the database (`authn_throttle` table) | Per-key compare-and-set with undo in reverse order; no transactions. A lost undo keeps a refused attempt's count |

A Redis store maps cleanly onto the contract: one hash per row (`attempts`, `lastAt`, `nextAt`) with `PEXPIREAT max(lastAt + resetAfter, nextAt)` on every write, which matches the expiry rule exactly. `attempt` is one Lua script that reads every gate and either returns the longest wait or increments all gates and counted rows, so it is atomic across keys. On Redis Cluster a multi-key script needs all keys of one call in one hash slot, eg. with a `{flow}` hash tag; the keys of one attempt are only guaranteed to share the flow. `succeed` is one Lua script too, and `peek` a read-only script.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `ThrottleStore` | Interface; not registered by util. Pass an instance as `ThrottleOptions.store`; share one per process, eg. as a DI value | `MemoryThrottleStore` | `DbThrottleStore` (`@spinajs/authn-orm`) | Implement `attempt`, `peek` and `succeed` per the contract |
| `MemoryThrottleStore` table per flow | `MemoryThrottleStoreOptions.limiter(flow, options)`; called once per flow on the first call for any flow | `new KeyedBackoff(options)` | A `KeyedBackoff` subclass, eg. authn's `FlowLimiter` | Return a **new** `KeyedBackoff` (or subclass) per flow |
| `MemoryThrottleStore` | Class, built with `new` | | | Subclass and override `attempt`, `peek`, `succeed`, calling `super` |

### Custom store over a shared key-value service

This store keeps rows in a remote key-value service and makes each call atomic with the service's lock. With Redis the `lock` callback body becomes a Lua script; with SQL, a transaction or compare-and-set statements. The in-memory `FakeKv` stands in for the remote service so the sample runs on its own.

```ts sample
import { DI } from '@spinajs/di';
import { KeyedBackoffVerdict, Throttle, ThrottleGate, ThrottleLower, ThrottleStore, backoffDelayMs } from '@spinajs/util';

interface Row {
  attempts: number;
  lastMs: number;
  nextMs: number;
}

/** What the store needs from the remote service: rows, TTLs, and one exclusive section per call. */
interface SharedKv {
  exclusive<R>(fn: () => Promise<R>): Promise<R>;
  get(id: string): Promise<Row | undefined>;
  set(id: string, row: Row, expireAtMs: number): Promise<void>;
  del(id: string): Promise<void>;
}

class FakeKv implements SharedKv {
  private readonly rows = new Map<string, { row: Row; expireAtMs: number }>();
  private tail: Promise<unknown> = Promise.resolve();

  public exclusive<R>(fn: () => Promise<R>): Promise<R> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }
  public async get(id: string) {
    const e = this.rows.get(id);
    return e ? { ...e.row } : undefined;
  }
  public async set(id: string, row: Row, expireAtMs: number) {
    this.rows.set(id, { row, expireAtMs });
  }
  public async del(id: string) {
    this.rows.delete(id);
  }
}

export class SharedKvThrottleStore implements ThrottleStore {
  constructor(
    private readonly kv: SharedKv,
    private readonly resetAfterMs: number,
  ) {}

  public attempt(_flow: string, gates: readonly ThrottleGate[], counted: readonly string[], nowMs: number): Promise<KeyedBackoffVerdict> {
    return this.kv.exclusive(async (): Promise<KeyedBackoffVerdict> => {
      const current = new Map<string, Row | undefined>();
      let waitMs = 0;
      for (const g of gates) {
        const row = await this.live(g.id, nowMs);
        current.set(g.id, row);
        if (row && row.nextMs > nowMs) waitMs = Math.max(waitMs, row.nextMs - nowMs);
      }
      if (waitMs > 0) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };

      for (const g of gates) {
        const attempts = (current.get(g.id)?.attempts ?? 0) + 1;
        const d = backoffDelayMs(g.backoff, attempts);
        await this.write(g.id, { attempts, lastMs: nowMs, nextMs: d > 0 ? nowMs + d : 0 });
      }
      for (const id of counted) {
        const row = await this.live(id, nowMs);
        await this.write(id, { attempts: (row?.attempts ?? 0) + 1, lastMs: Math.max(row?.lastMs ?? nowMs, nowMs), nextMs: row?.nextMs ?? 0 });
      }
      return { allowed: true };
    });
  }

  public async peek(_flow: string, gates: readonly ThrottleGate[], nowMs: number): Promise<KeyedBackoffVerdict> {
    let waitMs = 0;
    for (const g of gates) {
      const row = await this.live(g.id, nowMs);
      if (row && row.nextMs > nowMs) waitMs = Math.max(waitMs, row.nextMs - nowMs);
    }
    return waitMs > 0 ? { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) } : { allowed: true };
  }

  /** Rows carry no run number, so a target is lowered by the largest count consumed, like DbThrottleStore. */
  public succeed(_flow: string, lower: readonly ThrottleLower[], clear: readonly string[], nowMs: number): Promise<void> {
    return this.kv.exclusive(async () => {
      for (const { targets, by } of lower) {
        let spent = 0;
        for (const id of by) {
          spent = Math.max(spent, (await this.kv.get(id))?.attempts ?? 0);
          await this.kv.del(id);
        }
        for (const { id, backoff } of targets) {
          const row = await this.live(id, nowMs);
          if (!row) continue;
          const attempts = Math.max(0, row.attempts - spent);
          if (attempts === 0) {
            await this.kv.del(id);
            continue;
          }
          const d = backoffDelayMs(backoff, attempts);
          await this.write(id, { attempts, lastMs: row.lastMs, nextMs: d > 0 ? row.lastMs + d : 0 });
        }
      }
      for (const id of clear) await this.kv.del(id);
    });
  }

  private async live(id: string, nowMs: number): Promise<Row | undefined> {
    const row = await this.kv.get(id);
    if (row && nowMs - row.lastMs >= this.resetAfterMs && row.nextMs <= nowMs) return undefined;
    return row;
  }

  private write(id: string, row: Row): Promise<void> {
    return this.kv.set(id, row, Math.max(row.lastMs + this.resetAfterMs, row.nextMs));
  }
}

// one store per process, shared by every throttle through DI
DI.register(new SharedKvThrottleStore(new FakeKv(), 86_400_000)).asValue('throttle.store');

const resetThrottle = new Throttle({
  store: DI.get<ThrottleStore>('throttle.store')!,
  flows: { reset: { gates: { account: { free: 2, baseDelayMs: 30_000, maxDelayMs: 30_000 } } } },
});

(async () => {
  const keys = [{ kind: 'account', value: 'ann@example.com' }];
  for (let i = 0; i < 3; i++) console.log(await resetThrottle.attempt(keys, 'reset', Date.now()));
})().catch(console.error);
```

### `MemoryThrottleStore` limiter factory

`limiter(flow, options)` builds each flow's table. Use it to give a flow a `KeyedBackoff` subclass, different limits, or instrumentation. The store calls it for every flow on the first call for any flow, and fails with `InvalidOperation` when the factory returns something that is not a `KeyedBackoff`, or one instance for two flows.

```ts sample
import { KeyedBackoff, KeyedBackoffOptions, MemoryThrottleStore, Throttle } from '@spinajs/util';

class MeteredLimiter extends KeyedBackoff {
  public sweeps = 0;

  constructor(
    public readonly flow: string,
    options: KeyedBackoffOptions,
  ) {
    super(options);
  }

  public override sweep(nowMs: number, batch?: number): void {
    this.sweeps++;
    super.sweep(nowMs, batch);
  }
}

const store = new MemoryThrottleStore({
  flows: ['login', 'mfa'],
  maxRows: 100_000,
  resetAfterMs: 86_400_000,
  // MFA codes are short-lived: a smaller table with faster expiry
  limiter: (flow, options) => new MeteredLimiter(flow, flow === 'mfa' ? { ...options, maxRows: 10_000, resetAfterMs: 600_000 } : options),
});

const throttle = new Throttle({
  store,
  flows: {
    login: { gates: { account: { free: 5, baseDelayMs: 1_000, maxDelayMs: 60_000 } } },
    mfa: { gates: { account: { free: 3, baseDelayMs: 5_000, maxDelayMs: 300_000 } } },
  },
});

throttle
  .attempt([{ kind: 'account', value: 'ann' }], 'login', Date.now())
  .then(() => console.log((store.limiter('mfa') as MeteredLimiter).sweeps, store.limiter('login').size));
```

## Important behaviour

- `Throttle` validates every argument before calling the store, so a store receives only known flows, finite `nowMs` and string ids.
- `Throttle.succeed` calls the store even with empty `lower` and `clear`; treat it as the signal to end a full-table refusal.
- `MemoryThrottleStore.succeed` applies `lower` before `clear`, so a `by` id listed in `clear` still counts.
- `MemoryThrottleStore.attempt` also sweeps every other flow by `ceil(sweepBatch / 4)` rows; `peek` and `succeed` sweep nothing.
- `MemoryThrottleStore.limiter(flow)` exposes a flow's table for tests and diagnostics; an unknown flow throws `InvalidArgument`.
- When the factory returns an invalid value, the call throws and no table is kept; the next call runs the factory again for every flow.

## Best practices

- Test a custom store with a burst: `Promise.all` of `free + 5` attempts on a fresh key must allow exactly `free`.
- Compare times in the store against the `nowMs` you are given, never the database's `now()`; `Throttle` callers and tests rely on one clock.
- Keep `resetAfter` in the store equal to the throttle's configured decay, or rows expire at a different time than the rules assume.

## Related

- [Throttle](10-throttle.md): the rules layer that calls the store.
- [Keyed backoff](09-keyed-backoff.md): the per-flow table and `backoffDelayMs`.
- [`@spinajs/authn`](../authn/README.md): `StoreAuthnThrottle` runs authn's flows over any `ThrottleStore`; `@spinajs/authn-orm` ships `DbThrottleStore`.
