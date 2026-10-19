# Extending the Redis store

`RedisSessionStore` is a plain DI service: you can pick another store by name, subclass it and override any public or protected method, build the Redis connection yourself, or swap the expiration strategy it applies. Use this page when the defaults of [Redis session store](01-redis-session-store.md) do not fit: audit logging, connection tuning, a custom session lifetime.

## How it works

1. `@Injectable(SessionProvider)` registers a class under the `SessionProvider` token and as itself, when its module is imported. `RedisSessionStore` and each of your subclasses are separate registrations.
2. `DefaultSessionIssuer` resolves its store with `@AutoinjectService('authn.session', SessionProvider)`: the container reads `authn.session.service` and builds the registered `SessionProvider` with that class name. See [Config-selected services](../configuration/08-config-selected-services.md#autoinjectservice).
3. The store is a singleton, cached by its concrete class name. `DI.resolve(RedisSessionStore)` and the issuer get the same instance when `authn.session.service` is `'RedisSessionStore'`; with a subclass selected, resolve the subclass instead.
4. On the first resolve the container injects `Log` (`@Logger('redis-session-store')`), `RedisConfig` (`@Config('authn.session.redis')`) and `Expiration` (`@AutoinjectService('authn.session.expiration', SessionExpirationProvider)`, from `SessionProvider`), then awaits `resolve()`.
5. `resolve()` calls `createClient()` and `sweepLegacy()`. Every other method reads `this.Client`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.session.service` | `string` | `'MemorySessionStore'` | Class name of any registered `SessionProvider` | Selects the store, including your subclass |
| `authn.session.redis` | `RedisOptions` | not set: `{}` | ioredis options | Injected as `this.RedisConfig`; the default `createClient()` passes it to `new Redis()` |
| `authn.session.expiration.service` | `string` | `'SlidingCappedExpiration'` | Class name of any registered `SessionExpirationProvider` | Selects the expiration strategy |

```ts
export default {
  authn: {
    session: {
      service: 'AuditedRedisSessionStore',
      expiration: { service: 'ShiftExpiration', ttl: 30 },
      // Sentinel needs no code: ioredis reads it from the options.
      redis: { sentinels: [{ host: 'sentinel-1', port: 26379 }, { host: 'sentinel-2', port: 26379 }], name: 'sessions', keyPrefix: 'shop:' },
    },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Session store | `SessionProvider`, singleton, chosen by class name from `authn.session.service` | `MemorySessionStore` | `RedisSessionStore`, `DbSessionStore`, `DynamoDbSessionProvider` | Name another store in config; subclass `RedisSessionStore`; or extend `SessionProvider` and implement its seven abstract methods |
| Store behaviour | Methods of `RedisSessionStore` | This package | Your subclass | Override public and protected methods; call `super` to keep the guarantees |
| Redis connection | `createClient(): Redis`, called once in `resolve()` | `new Redis(this.RedisConfig ?? {})` | Your override | Override `createClient()`; override `dispose()` too when the client is shared |
| Key layout | `sessionKey(id)`, `indexKey(role, ref)` | `session:<id>`, `session:<role>:<principalKey>` | `authn.session.redis.keyPrefix` | Prefer `keyPrefix`; overriding the methods is [limited](#key-layout-sessionkey-and-indexkey) |
| Expiration strategy | `SessionExpirationProvider`, resolved by name from `authn.session.expiration.service` | `SlidingCappedExpiration` | `AbsoluteExpiration`, `SlidingExpiration` | Register a class with `@Injectable(SessionExpirationProvider)` and name it in config |

### Session store: subclass `RedisSessionStore`

Subclass to add behaviour around the shipped operations: audit logs, metrics, extra keys. Decorate the subclass with `@Injectable(SessionProvider)`, import its module before the issuer is first resolved, and set `authn.session.service` to its class name.

Overridable members:

| Member | Visibility | Use it to |
| --- | --- | --- |
| `resolve()`, `dispose()` | public | Add boot or shutdown steps; call `super` |
| `restore`, `save`, `touch`, `delete`, `deleteBySubject`, `listBySubject`, `truncate` | public | Wrap the `SessionProvider` contract; call `super` to keep the atomicity and race handling |
| `sweepLegacy()` | public | Skip or replace the [boot sweep](02-legacy-session-sweep.md) |
| `createClient()` | protected | Build the connection |
| `sessionKey()`, `indexKey()`, `indexSetsOf()` | protected | Change key names or which sets a row joins |
| `toSession()`, `isStored30()`, `instant()` | protected | Read another stored shape |
| `lookup()`, `prune()`, `scanSessionKeys()`, `expireAt()`, `exec()`, `expirationEquals()` | protected | Low-level helpers the operations share |
| `Log`, `RedisConfig`, `Client`, `Expiration` | protected fields | The logger, the raw config, the ioredis client, the expiration strategy |

The example below writes an audit line for every mass revocation (ban, password reset, "sign out everywhere"):

```ts sample
import { FrameworkConfiguration } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import { SessionProvider } from '@spinajs/authn-session';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { RedisSessionStore } from '@spinajs/session-provider-redis';
import _ from 'lodash';

@Injectable(SessionProvider)
export class AuditedRedisSessionStore extends RedisSessionStore {
  public async deleteBySubject(subject: IdentityRef, opts?: { includeImpersonations?: boolean; except?: string }): Promise<number> {
    const count = await super.deleteBySubject(subject, opts);
    this.Log.info({ type: subject.type, id: subject.id, count, impersonations: opts?.includeImpersonations === true }, 'Revoked ${count} sessions of ${type}:${id}');
    return count;
  }
}

export class AppConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.Config = _.merge(this.Config, {
      authn: { session: { service: 'AuditedRedisSessionStore', redis: { host: 'redis.internal', keyPrefix: 'shop:' } } },
    });
  }
}
```

### Redis connection: `createClient()`

Override `createClient()` to tune or observe the connection: an `error` listener that routes failures to the store's logger, a bounded retry, a connection name shown in `CLIENT LIST`. It runs once, in `resolve()`, before the boot sweep. Plain options such as TLS or Sentinel need no override: put them in `authn.session.redis`.

```ts sample
import { Injectable } from '@spinajs/di';
import { SessionProvider } from '@spinajs/authn-session';
import { RedisSessionStore } from '@spinajs/session-provider-redis';
import { Redis } from 'ioredis';

/** Select with `authn.session.service: 'ObservedRedisSessionStore'`. */
@Injectable(SessionProvider)
export class ObservedRedisSessionStore extends RedisSessionStore {
  protected createClient(): Redis {
    const client = new Redis({
      ...this.RedisConfig,
      connectionName: 'sessions',
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => Math.min(times * 200, 5000),
    });
    client.on('error', (err: Error) => this.Log.error(err, 'Redis session connection failed'));
    return client;
  }
}
```

The return type is `Redis`; an ioredis `Cluster` does not fit, and the store's `MULTI` and `SCAN` calls do not work across Cluster slots.

### Key layout: `sessionKey()` and `indexKey()`

Use `authn.session.redis.keyPrefix` to separate applications, tenants or environments in one Redis. It applies to every command, the Lua script, `SCAN` and `truncate()`.

`scanSessionKeys()`, `truncate()` and `sweepLegacy()` derive their patterns and the row-id offset from `sessionKey()` and `indexKey()`, so overriding them is safe as long as `sessionKey('*')` and `indexKey(role, { type: '*', id: '*' })` are valid glob patterns for your layout.

```ts
// Works with truncate() and the boot sweep, but a prefix is simpler:
protected sessionKey(sessionId: string): string {
  return `tenant-a:sess:${sessionId}`;
}

// Prefer: one prefix for every key the store owns.
export default { authn: { session: { redis: { keyPrefix: 'tenant-a:' } } } };
```

### Expiration strategy: `SessionExpirationProvider`

The store calls `Expiration.initial(session)` in `save()` when a session has no `Expiration`, and `Expiration.renew(session)` in `touch()` for an active session. The result also sets the Redis TTL (`PEXPIREAT`); `undefined` means the session never expires and the key gets no TTL.

Register a class with `@Injectable(SessionExpirationProvider)` and set `authn.session.expiration.service` to its class name. The example ends every session at the end of the shift it started in, with a 30-minute idle timeout before that:

```ts sample
import { DateTime } from 'luxon';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { SessionExpirationProvider } from '@spinajs/authn-session';
import type { ISession } from '@spinajs/authn-session';

/** Select with `authn.session.expiration: { service: 'ShiftExpiration', ttl: 30, shiftEndHour: 18 }`. */
@Injectable(SessionExpirationProvider)
export class ShiftExpiration extends SessionExpirationProvider {
  @Config('authn.session.expiration.ttl', { defaultValue: 30 })
  protected Ttl!: number;

  @Config('authn.session.expiration.shiftEndHour', { defaultValue: 18 })
  protected ShiftEndHour!: number;

  public initial(session: ISession): DateTime | undefined {
    return this.renew(session);
  }

  public renew(session: ISession): DateTime | undefined {
    const idle = DateTime.now().plus({ minutes: this.Ttl });
    let shiftEnd = session.Creation.set({ hour: this.ShiftEndHour, minute: 0, second: 0, millisecond: 0 });
    if (shiftEnd <= session.Creation) {
      shiftEnd = shiftEnd.plus({ days: 1 });
    }
    return idle < shiftEnd ? idle : shiftEnd;
  }
}
```

A pending (pre-MFA) session never reaches the strategy on `touch()`, and must carry its own `Expiration` on `save()`; see [Redis session store](01-redis-session-store.md#save-savesession).

## Important behaviour

- **Register before the first resolve.** The issuer picks its store once, when it is built. A subclass imported after that is never used.
- **The class name is the selector.** `authn.session.service` must equal the subclass's class name exactly.
- **Two registrations, one selected.** Importing `@spinajs/session-provider-redis` always registers `RedisSessionStore`; it stays unused when config names your subclass.
- **`dispose()` quits `this.Client`.** A client shared with other code is closed with it; override `dispose()` when you hand in a shared client.
- **Overrides must keep the contract** of `SessionProvider`: `restore` returns `null` for expired rows, `touch` never re-creates a deleted row, `delete` returns `true` only for the call that removed the key. Calling `super` keeps these.

## Best practices

- Wrap with `super` calls instead of reimplementing `touch()` or `deleteBySubject()`; their compare-and-set and repeat-until-stable loops are what make revocation safe under races.
- Keep `createClient()` free of `await` and I/O; it is synchronous and runs inside `resolve()`.
- Give a custom expiration strategy its settings under `authn.session.expiration`, next to the shipped `ttl`, so one config block describes the session lifetime.

## Examples

### Count deleted sessions in a metrics registry

```ts sample
import { Injectable } from '@spinajs/di';
import { SessionProvider } from '@spinajs/authn-session';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { RedisSessionStore } from '@spinajs/session-provider-redis';

export const deletedSessions = { total: 0 };

/** Select with `authn.session.service: 'MeteredRedisSessionStore'`. */
@Injectable(SessionProvider)
export class MeteredRedisSessionStore extends RedisSessionStore {
  public async delete(sessionId: string): Promise<boolean> {
    const deleted = await super.delete(sessionId);
    if (deleted) {
      deletedSessions.total++;
    }
    return deleted;
  }

  public async deleteBySubject(subject: IdentityRef, opts?: { includeImpersonations?: boolean; except?: string }): Promise<number> {
    const count = await super.deleteBySubject(subject, opts);
    deletedSessions.total += count;
    return count;
  }
}
```

`deleteBySubject()` deletes through its own `MULTI`, not through `delete()`, so each session is counted once. `restore()` calls `delete()` for an expired row, so that cleanup is counted too.

### Skip the boot sweep once no 2.x session can be left

```ts sample
import { Injectable } from '@spinajs/di';
import { SessionProvider } from '@spinajs/authn-session';
import { RedisSessionStore } from '@spinajs/session-provider-redis';

/** For a deployment upgraded long ago: boot no longer scans every session key. */
@Injectable(SessionProvider)
export class UpgradedRedisSessionStore extends RedisSessionStore {
  public async resolve(): Promise<void> {
    this.Client = this.createClient();
  }
}
```

`resolve()` is replaced, not extended, so the sweep does not run; `sweepLegacy()` stays callable by hand. Do this only when every 2.x session has expired (their longest lifetime has passed since the upgrade).

## Related

- [Redis session store](01-redis-session-store.md): the operations these overrides wrap.
- [2.x sessions and the boot sweep](02-legacy-session-sweep.md): what `sweepLegacy()` does at boot.
- [Config-selected services](../configuration/08-config-selected-services.md): how `@AutoinjectService` resolves the store and the strategy by name.
- [Lifetimes](../di/04-lifetimes.md): why the store is one instance per container.
- [`@spinajs/authn` sessions](../authn/README.md#sessions): the `SessionProvider` contract every store implements.
