# `@spinajs/session-provider-db`

A relational database session store for `@spinajs/authn-session`. `DbSessionStore` implements `SessionProvider` over one table, `user_sessions`, through `@spinajs/orm`, and ships the migrations that create and upgrade that table.

It does **not** issue, hash or rotate session ids, and it does not set cookies: `DefaultSessionIssuer` in `@spinajs/authn-session` does that and calls this store for storage. It runs on MySQL / MariaDB, PostgreSQL and SQLite. MSSQL is **not** supported: the session id migration fails there (see [Session table and migrations](02-session-table-and-migrations.md#important-behaviour)).

## Install

```sh
npm install @spinajs/session-provider-db @spinajs/authn-session @spinajs/orm
```

Add one ORM driver, for example `@spinajs/orm-mysql`.

## Features

| Feature | What it does |
| --- | --- |
| [Database session store](01-db-session-store.md) | `DbSessionStore`: selection by `authn.session.service`, save, restore, touch, revocation by subject, the expired-session sweep, 2.x rows |
| [Session table and migrations](02-session-table-and-migrations.md) | The `user_sessions` table, the `DbSession` model, the `session-provider-connection` name and the four migrations |
| [Extending the session store](03-extending-the-session-store.md) | Every extension point: the `SessionProvider` token, subclassing `DbSessionStore`, the expiration strategy, the connection binding, extra migrations, the log category |

## Quick start

```ts sample
import { FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import '@spinajs/orm-mysql';
import { DbSessionStore } from '@spinajs/session-provider-db';
import _ from 'lodash';

export class AppConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      authn: {
        session: {
          service: 'DbSessionStore',
          expiration: { service: 'SlidingCappedExpiration', ttl: 30, maxLifetime: 480 },
          db: { cleanupInterval: 5 * 60 * 1000 },
        },
      },
      db: {
        DefaultConnection: 'main',
        Aliases: { 'session-provider-connection': 'main' },
        Connections: [
          {
            Name: 'main',
            Driver: 'orm-driver-mysql',
            Host: '127.0.0.1',
            Port: 3306,
            User: 'app',
            Password: 'secret',
            Database: 'shop',
            Migration: { OnStartup: true },
          },
        ],
      },
    });
  }
}

/** Number of devices a customer is signed in on, for the support panel. */
export async function activeDeviceCount(userUuid: string): Promise<number> {
  await DI.resolve(Orm);
  const store = await DI.resolve(DbSessionStore);
  const sessions = await store.listBySubject({ type: 'user', id: userUuid });
  return sessions.length;
}
```

Importing `@spinajs/session-provider-db` registers `DbSessionStore` and the four migrations. `authn.session.service: 'DbSessionStore'` makes the session issuer use it; `db.Aliases` points the store's connection name at the main database, which must also hold the `users` table.

## Related packages

- [`@spinajs/authn`](../authn/README.md#sessions): the session contract, the issuer, ids, states and revocation this store serves.
- [`@spinajs/orm`](../orm/README.md): models, [connections and aliases](../orm/01-connections.md) and [migrations](../orm/10-migrations.md) the store runs on.
- [`@spinajs/orm-mysql`](../orm-mysql/README.md), [`@spinajs/orm-sqlite`](../orm-sqlite/README.md): drivers the migrations run on; each spells the column changes its own way.
- [`@spinajs/session-provider-redis`](../session-provider-redis/README.md), [`@spinajs/session-provider-dynamodb`](../session-provider-dynamodb/README.md): the other shipped `SessionProvider` stores.
- [`@spinajs/users`](../users/README.md): creates the `users` table that `user_sessions.UserId` references.
