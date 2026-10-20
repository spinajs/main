# Extending the session store

Every part of the database session store can be swapped or extended without forking the package: the store class behind the `SessionProvider` token, the expiration strategy it calls, the connection its model and migrations use, the table's migrations, and its log output.

## How it works

1. At import, `@Injectable(SessionProvider)` registers each store class under `SessionProvider` and under its own type. `DbSessionStore`, `MemorySessionStore`, `RedisSessionStore`, `DynamoDbSessionProvider` and your subclasses all sit side by side.
2. When `DefaultSessionIssuer` is built, `@AutoinjectService('authn.session', SessionProvider)` reads `authn.session.service` and picks the registered class whose **class name** equals that value. The container builds it once (singleton) and calls its `resolve()`.
3. The store's base class, `SessionProvider`, gets its expiration strategy the same way: `@AutoinjectService('authn.session.expiration', SessionExpirationProvider)` picks the class named by `authn.session.expiration.service`.
4. `DbSession` and the migrations find their database through the ORM connection name `session-provider-connection`.

A replacement class must be imported, so that its decorator runs, before the container builds `DefaultSessionIssuer`. Import it from your application's entry module.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Session store | `SessionProvider`, singleton, by class name from `authn.session.service` | `MemorySessionStore` | `DbSessionStore`, `RedisSessionStore` (`@spinajs/session-provider-redis`), `DynamoDbSessionProvider` (`@spinajs/session-provider-dynamodb`) | Name another store in config, or subclass `DbSessionStore` with `@Injectable(SessionProvider)` and name the subclass. |
| `DbSessionStore` hooks | protected members of the class | the shipped bodies | | Override `cleanupExpired()`, `toSession()`, `matching()`, `resolve()` / `dispose()`, or `CleanupInterval`. |
| Expiration strategy | `SessionExpirationProvider`, singleton, by class name from `authn.session.expiration.service` | `SlidingCappedExpiration` | `AbsoluteExpiration`, `SlidingExpiration` | `@Injectable(SessionExpirationProvider)` on your class, then name it in config. |
| Connection binding | ORM connection name `session-provider-connection` | none | any configured connection | `db.Aliases`, or a connection with that `Name`. |
| Table migrations | `@Migration('session-provider-connection')`, registered in DI at import | the four shipped migrations | | Add your own migration on the same connection name, with a later timestamp. |
| Log output | logger category `db-session-store` (`@Logger`) | the application's log rules | | Add a `logger.rules` entry for `db-session-store`. |

### Session store: subclass `DbSessionStore`

Subclass when the storage stays `user_sessions` but one behaviour changes. The members meant for overriding:

| Member | Override to |
| --- | --- |
| `cleanupExpired(): Promise<number>` | change what the sweep deletes, or report it elsewhere. |
| `toSession(row, lenient)` | build the `ISession` differently, for example from extra columns. Keep returning `null` for a 2.x row without owner. |
| `matching(subject, includeImpersonations)` | narrow or widen which rows a revocation or listing reaches. |
| `resolve()` / `dispose()` | start or stop extra work. Call `super` to keep the sweep timer. |
| `CleanupInterval` | fix the sweep period in code instead of config. |

The public storage methods (`restore`, `save`, `touch`, `delete`, `deleteBySubject`, `listBySubject`) carry the security rules of the session contract: update-only `touch`, fail-closed `State`, exact revocation counts. Wrap them with `super` calls rather than rewriting them.

```ts sample
import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import { SessionProvider } from '@spinajs/authn-session';
import { DbSession, DbSessionStore } from '@spinajs/session-provider-db';
import { DateTime } from 'luxon';

/**
 * Keeps expired sessions for the security audit trail, then deletes them.
 * restore() and listBySubject() already treat expired rows as absent.
 */
@Injectable(SessionProvider)
export class AuditRetentionSessionStore extends DbSessionStore {
  @Config('security.audit.sessionRetentionDays', { defaultValue: 30 })
  protected RetentionDays: number;

  public async cleanupExpired(): Promise<number> {
    const cutoff = DateTime.now().minus({ days: this.RetentionDays });
    const old = await DbSession.where('Expiration', '<=', cutoff);

    if (old.length === 0) {
      return 0;
    }

    await DbSession.destroy(old.map((s) => s.SessionId));
    this.Log.info(`Deleted ${old.length} sessions past the audit retention`);
    return old.length;
  }
}

export const sessionConfig = {
  authn: {
    session: {
      service: 'AuditRetentionSessionStore',
      db: { cleanupInterval: 60 * 60 * 1000 },
    },
  },
  security: {
    audit: { sessionRetentionDays: 90 },
  },
};
```

`authn.session.service: 'AuditRetentionSessionStore'` makes the issuer use the subclass; `DbSessionStore` stays registered and unused.

### Session store: wrap a public method

Wrap a storage method to add a side effect, and let `super` keep the contract.

```ts sample
import { Injectable } from '@spinajs/di';
import { SessionProvider } from '@spinajs/authn-session';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { DbSessionStore } from '@spinajs/session-provider-db';

/** Writes one audit line for every revocation that ended live sessions. */
@Injectable(SessionProvider)
export class RevocationAuditSessionStore extends DbSessionStore {
  public async deleteBySubject(subject: IdentityRef, opts?: { includeImpersonations?: boolean; except?: string }): Promise<number> {
    const count = await super.deleteBySubject(subject, opts);

    if (count > 0) {
      this.Log.warn(`Revoked ${count} sessions of ${subject.type}:${subject.id}`);
    }

    return count;
  }
}
```

Set `authn.session.service` to `RevocationAuditSessionStore`.

### Expiration strategy

The store calls `SessionExpirationProvider.initial()` in `save()` for a session without expiration, and `renew()` in `touch()` for an `active` session. A custom strategy changes how long every session lives, for every store.

```ts sample
import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import { SessionExpirationProvider } from '@spinajs/authn-session';
import type { ISession } from '@spinajs/authn-session';
import { DateTime } from 'luxon';

/** Slides by the idle ttl, but every back-office session ends at midnight. */
@Injectable(SessionExpirationProvider)
export class EndOfDayExpiration extends SessionExpirationProvider {
  @Config('authn.session.expiration.ttl')
  protected Ttl: number;

  public initial(session: ISession): DateTime | undefined {
    return this.renew(session);
  }

  public renew(_session: ISession): DateTime | undefined {
    const idle = DateTime.now().plus({ minutes: this.Ttl });
    const midnight = DateTime.now().endOf('day');
    return idle < midnight ? idle : midnight;
  }
}

export const expirationConfig = {
  authn: {
    session: {
      service: 'DbSessionStore',
      expiration: { service: 'EndOfDayExpiration', ttl: 30 },
    },
  },
};
```

### Connection binding

`DbSession` and the four migrations name the connection `session-provider-connection`. Point it at the application database with `db.Aliases`, or give a connection that name. A separate database must also contain `users`, unless its engine does not enforce the foreign key of the create migration, as SQLite does by default.

```ts sample
import { FrameworkConfiguration } from '@spinajs/configuration';
import '@spinajs/orm-sqlite';
import '@spinajs/session-provider-db';
import _ from 'lodash';

/** Integration tests: sessions in their own in-memory SQLite database. */
export class SessionTestConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      authn: {
        session: {
          service: 'DbSessionStore',
          expiration: { service: 'SlidingExpiration', ttl: 60 },
          db: { cleanupInterval: 1000 },
        },
      },
      db: {
        DefaultConnection: 'app',
        Connections: [
          { Name: 'app', Driver: 'orm-driver-sqlite', Filename: ':memory:', Migration: { OnStartup: true } },
          { Name: 'session-provider-connection', Driver: 'orm-driver-sqlite', Filename: ':memory:', Migration: { OnStartup: true } },
        ],
      },
    });
  }
}
```

The migrations recognise dialects by the exact driver name: `orm-driver-mysql`, `orm-driver-mysql-ssh`, `orm-driver-postgres`, `orm-driver-sqlite`. A driver subclass registered under its own name gets no dialect branch; see [Session table and migrations](02-session-table-and-migrations.md#important-behaviour).

### Extra migrations

Add your own migration on `session-provider-connection` to change `user_sessions`. Give it a timestamp later than `2026_10_02_00_00_00`, so it runs after the shipped ones.

```ts sample
import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';
import '@spinajs/session-provider-db';

/** The expired-session sweep filters on Expiration; index it for large tables. */
@Migration('session-provider-connection')
export class UserSessionsExpirationIndex_2026_10_20_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.index().table('user_sessions').name('user_sessions_expiration_idx').columns(['Expiration']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    const mysql = ['orm-driver-mysql', 'orm-driver-mysql-ssh'].includes(connection.Options?.Driver);
    await connection.schema().raw(mysql ? 'DROP INDEX user_sessions_expiration_idx ON user_sessions' : 'DROP INDEX user_sessions_expiration_idx');
  }
}
```

Import the module that declares it from your application, so `@Migration()` registers it before `Orm` resolves.

### Log output

`DbSessionStore` logs under the category `db-session-store`: one `info` line per sweep, an `error` line when a sweep fails, and a `warn` line for each undecodable row a revocation or listing skips.

```ts
logger: {
  rules: [
    { name: 'db-session-store', level: 'warn', target: 'Console' },
  ],
},
```

## Important behaviour

- Selection is by class name. Two registered `SessionProvider` classes with the same name make the choice ambiguous, and a minifier that renames classes breaks it.
- `DI.resolve(DbSessionStore)` builds the base class, not your subclass: a second store instance with its own sweep timer. Resolve the subclass by its own type.
- An unknown `authn.session.service` value fails when the issuer is built, with `ServiceNotFound`.
- The store's `Expiration` strategy is shared by every store; changing it changes `MemorySessionStore`, Redis and DynamoDB stores the same way.

## Patterns and antipatterns

```ts
// Don't: SessionIssuer.set() persists Data through touch(); skipping super.touch() drops those writes.
public async touch(session: ISession): Promise<boolean> {
  return false;
}

// Do: call super, add your side effect around it.
public async touch(session: ISession): Promise<boolean> {
  const renewed = await super.touch(session);
  this.Log.trace(`touch ${renewed}`);
  return renewed;
}
```

```ts
// Don't: a subclass without @Injectable(SessionProvider) is not a candidate for authn.session.service.
export class TenantSessionStore extends DbSessionStore {}

// Do
@Injectable(SessionProvider)
export class TenantSessionStore extends DbSessionStore {}
```

## Related

- [Database session store](01-db-session-store.md): the flows these hooks sit in.
- [Session table and migrations](02-session-table-and-migrations.md): the table your extra migrations change.
- [`@spinajs/authn` sessions](../authn-session/README.md): the issuer and the session contract.
- [Migrations](../orm/10-migrations.md#ship-migrations-from-a-plugin-package): registering migrations from a package.
- [`@spinajs/log`](../log/README.md): logger categories and rules.
