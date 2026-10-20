# Writing a session store

Write a `SessionProvider` when sessions must live in a backend the shipped stores do not cover: a key-value service of your platform, another database, an existing session table. Subclass a shipped store instead when you only change part of its behaviour; each store package documents its hooks.

## How it works

1. Subclass `SessionProvider` and decorate the class with `@Injectable(SessionProvider)`.
2. Implement the seven abstract methods. Call the expiration helpers of the base: the protected `applyInitialExpiration()` in `save` and `applyRenewedExpiration()` in `touch`, the public `isExpired()` on every read.
3. Serialize `Data` with [`encodeSessionData` / `decodeSessionData`](06-session-data-codec.md), so `Map`, `Set` and luxon `DateTime` values survive.
4. Import the module in the app entry and set `authn.session.service` to the class name.
5. `DefaultSessionIssuer` resolves the store when it is first built and calls it from then on.

The rules every store keeps (the issuer's guarantees depend on them):

| Method | Rule |
| --- | --- |
| `restore(sessionId)` | Missing or expired: `null` |
| `save(session)` | Upsert. Call `applyInitialExpiration()` only when `session.Expiration === undefined`; otherwise persist `Expiration` verbatim |
| `touch(session)` | Update-only: when the stored row is gone or expired, write nothing and answer `false`. Otherwise call `applyRenewedExpiration()`, write `Expiration` and `Data`, and answer whether the expiration changed. A compare-and-set or conditional write closes the race with a parallel delete |
| `delete(sessionId)` | One atomic operation; `true` only for the call that removed the row |
| `deleteBySubject(subject, opts)` | Match `Subject` (and `Impersonator` with `includeImpersonations: true`) by `type` and `id`; skip the `except` key; answer the number of live rows deleted |
| `listBySubject(subject, opts)` | The same matching; live rows only |
| `truncate()` | Delete every row |

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.session.service` | string | `'MemorySessionStore'` | your store's class name | Selects your store |
| `authn.session.<your key>` | any | | | The whole `authn.session` object is the store's constructor argument, so a store can read its own sub-object, as `authn.session.redis` does for `RedisSessionStore` |

```ts
authn: {
  session: {
    service: 'KvSessionStore',
  },
},
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Session store | `SessionProvider`, singleton, selected by `authn.session.service` | `MemorySessionStore` | `DbSessionStore`, `RedisSessionStore`, `DynamoDbSessionProvider` | `@Injectable(SessionProvider)` on your class, imported before the issuer is first resolved; name it in config |
| Row class | `UserSession`, `@NewInstance()` | `UserSession` | any object of the `ISession` shape | Build the rows `restore` returns with `new UserSession(partial)` |
| Data codec | functions `encodeSessionData`, `decodeSessionData` | | | Use them as they are; see [Session data codec](06-session-data-codec.md) |

### `SessionProvider`: custom implementation

A store over a key-value service. `KvClient` stands for your platform's client; register a concrete one with `DI.register(MyKvClient).as(KvClient)`.

```ts sample
import { DateTime } from 'luxon';
import { Autoinject, Injectable } from '@spinajs/di';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { SessionProvider, UserSession, decodeSessionData, encodeSessionData } from '@spinajs/authn-session';
import type { ISession } from '@spinajs/authn-session';

/** The client of your key-value service. */
export abstract class KvClient {
  public abstract get(key: string): Promise<string | null>;
  public abstract set(key: string, value: string): Promise<void>;
  /** Writes only when the key exists; true when it wrote. */
  public abstract replace(key: string, value: string): Promise<boolean>;
  /** True only when this call removed the key. */
  public abstract del(key: string): Promise<boolean>;
  public abstract keys(prefix: string): Promise<string[]>;
}

interface StoredRow {
  SessionId: string;
  Subject: IdentityRef;
  Impersonator?: IdentityRef;
  State: ISession['State'];
  Creation: number;
  Expiration?: number;
  Data: string;
}

const PREFIX = 'session:';
const same = (a: IdentityRef | undefined, b: IdentityRef) => !!a && a.type === b.type && a.id === b.id;

@Injectable(SessionProvider)
export class KvSessionStore extends SessionProvider {
  @Autoinject(KvClient)
  protected Kv!: KvClient;

  public async restore(sessionId: string): Promise<ISession | null> {
    const raw = await this.Kv.get(PREFIX + sessionId);
    return raw === null ? null : this.live(raw);
  }

  public async save(session: ISession): Promise<void> {
    if (session.Expiration === undefined) {
      this.applyInitialExpiration(session);
    }
    await this.Kv.set(PREFIX + session.SessionId, this.serialize(session));
  }

  public async touch(session: ISession): Promise<boolean> {
    if (!(await this.restore(session.SessionId))) {
      return false;
    }
    const before = session.Expiration?.toMillis();
    this.applyRenewedExpiration(session);
    // replace() never re-creates a row a logout deleted after the read above.
    const written = await this.Kv.replace(PREFIX + session.SessionId, this.serialize(session));
    return written && before !== session.Expiration?.toMillis();
  }

  public async delete(sessionId: string): Promise<boolean> {
    return this.Kv.del(PREFIX + sessionId);
  }

  public async deleteBySubject(subject: IdentityRef, opts?: { includeImpersonations?: boolean; except?: string }): Promise<number> {
    let count = 0;
    for (const session of await this.listBySubject(subject, opts)) {
      if (session.SessionId !== opts?.except && (await this.delete(session.SessionId))) {
        count++;
      }
    }
    return count;
  }

  public async listBySubject(subject: IdentityRef, opts?: { includeImpersonations?: boolean }): Promise<ISession[]> {
    const out: ISession[] = [];
    for (const key of await this.Kv.keys(PREFIX)) {
      const raw = await this.Kv.get(key);
      const session = raw === null ? null : this.live(raw);
      if (session && (same(session.Subject, subject) || (opts?.includeImpersonations === true && same(session.Impersonator, subject)))) {
        out.push(session);
      }
    }
    return out;
  }

  public async truncate(): Promise<void> {
    for (const key of await this.Kv.keys(PREFIX)) {
      await this.Kv.del(key);
    }
  }

  protected live(raw: string): ISession | null {
    const row = JSON.parse(raw) as StoredRow;
    const session = new UserSession({
      SessionId: row.SessionId,
      Subject: row.Subject,
      Impersonator: row.Impersonator,
      State: row.State,
      Creation: DateTime.fromMillis(row.Creation),
      Expiration: row.Expiration === undefined ? undefined : DateTime.fromMillis(row.Expiration),
      Data: decodeSessionData(row.Data),
    });
    return this.isExpired(session) ? null : session;
  }

  protected serialize(s: ISession): string {
    const row: StoredRow = {
      SessionId: s.SessionId,
      Subject: s.Subject,
      Impersonator: s.Impersonator,
      State: s.State,
      Creation: s.Creation.toMillis(),
      Expiration: s.Expiration?.toMillis(),
      Data: encodeSessionData(s.Data),
    };
    return JSON.stringify(row);
  }
}
```

The example scans every key in `listBySubject`. A production store keeps a secondary index per subject and per impersonator instead, as `RedisSessionStore` does with sets and `DbSessionStore` with indexed columns.

## Important behaviour

- **Revocation depends on `touch`.** A `touch` that writes a deleted row back undoes a logout or ban that raced a request. Use a conditional write.
- **`delete` decides parallel rotations.** The issuer keeps a rotated copy only when its own `delete` of the old row answered `true`; a store that answers `true` twice lets two rotations of one session succeed.
- **Pending rows.** `applyInitialExpiration()` throws for a pending row without `Expiration`; the issuer always gives one, so the error means the store lost the field.
- **Count.** `deleteBySubject` answers live rows; the count is what `DELETE /user/sessions` of `@spinajs/authn-http` returns as `Revoked`.

## Best practices

- Run both conformance suites against your store:
  - `runSessionIssuerConformance()` of [`@spinajs/authn-testing`](../authn-testing/README.md) drives `DefaultSessionIssuer` over your store (the shipped stores run it).
  - `runSessionProviderConformance()` checks the store contract directly. It lives in `packages/authn-session/test/conformance/session-provider-conformance.ts` and is not published; the shipped stores import it by relative path inside the monorepo.
- Keep `Data` opaque: never read or rewrite entries starting with `authn:`.
- Keep the expiration logic in the strategy. A store that computes its own deadlines breaks the guarantee that every store expires a session at the same instant.

## Patterns and antipatterns

```ts
// Don't: an unconditional write in touch re-creates a row that a logout just deleted
public async touch(session: ISession): Promise<boolean> {
  this.applyRenewedExpiration(session);
  await this.Kv.set(PREFIX + session.SessionId, this.serialize(session));
  return true;
}

// Do: write only when the row still exists
const written = await this.Kv.replace(PREFIX + session.SessionId, this.serialize(session));
```

## Examples

### Register the store and its client in the app entry

```ts
import { DI } from '@spinajs/di';
import { KvClient } from './session/kv-session-store.js';
import { PlatformKvClient } from './platform/kv.js';

DI.register(PlatformKvClient).as(KvClient);
```

Loading `kv-session-store.js` runs `@Injectable(SessionProvider)`, which registers `KvSessionStore`. With `authn.session.service: 'KvSessionStore'` the issuer picks it up when it is first resolved.

## Related

- [Session stores](04-session-stores.md): the contract and the shipped stores.
- [Session data codec](06-session-data-codec.md): `Data` serialization.
- [Extending the session store (db)](../session-provider-db/03-extending-the-session-store.md), [Extending the Redis store](../session-provider-redis/03-extending-the-redis-store.md): subclassing a shipped store instead.
