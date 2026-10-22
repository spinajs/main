# `@spinajs/email-verification-orm`

A relational-database store for [`@spinajs/email-verification`](../email-verification/README.md). `OrmEmailVerificationStore` keeps the cached verdicts, the domain lists and the sync state in four tables on an `@spinajs/orm` connection, and ships the migration that creates them.

It does **not** open the database connection: you configure the connection, the package only uses it.

## Install

```sh
npm install @spinajs/email-verification @spinajs/email-verification-orm @spinajs/orm
```

Install the ORM driver you use, for example `@spinajs/orm-sqlite`.

## Features

| Feature | What it does |
| --- | --- |
| [ORM store](01-orm-store.md) | Selection and configuration, the migration and tables, generation-based list writes, the expired-data cleanup, clock requirements |

## Quick start

```ts sample
import { FrameworkConfiguration } from '@spinajs/configuration';
import '@spinajs/email-verification-orm';
import _ from 'lodash';

export class AppConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      emailVerification: { enabled: true, store: 'OrmEmailVerificationStore' },
      db: {
        Connections: [{ Driver: 'orm-driver-sqlite', Filename: 'email-verification.sqlite', Name: 'email-verification-connection', Migration: { OnStartup: true } }],
      },
    });
  }
}
```

Importing the package registers the store and its migration. With `Migration.OnStartup` the tables are created at boot.

## Related packages

- [`@spinajs/email-verification`](../email-verification/README.md): the service, verifiers and the store contract.
- [`@spinajs/orm`](../orm/01-connections.md): connections and migrations.
- [`@spinajs/email-verification-redis`](../email-verification-redis/README.md), [`@spinajs/email-verification-dynamodb`](../email-verification-dynamodb/README.md): the other shared stores.
