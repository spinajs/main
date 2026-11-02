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

Point `emailVerification.orm.connection` at a connection your app already defines in `db.Connections`:

```js
// config/email-verification.js of your app
import '@spinajs/email-verification-orm';

export default {
  emailVerification: {
    enabled: true,
    store: 'OrmEmailVerificationStore',
    orm: { connection: 'main' },
  },
};
```

Importing the package registers the store and its migration; a config module is loaded by the app and by the `spinajs` CLI alike ([why that matters](../email-verification/05-cli.md#the-store-package-in-the-cli-process)). The migration runs on that connection, so with its `Migration.OnStartup: true` the tables are created at boot.

Do not add a connection for the store by merging a `db.Connections` array into the app's config: a later config file's array replaces the app's list, and `_.merge` in a `FrameworkConfiguration` subclass merges arrays index by index, which overwrites the app's first connection. If the store needs its own database, define that connection next to the others, in the same config file.

## Related packages

- [`@spinajs/email-verification`](../email-verification/README.md): the service, verifiers and the store contract.
- [`@spinajs/orm`](../orm/01-connections.md): connections and migrations.
- [`@spinajs/email-verification-redis`](../email-verification-redis/README.md), [`@spinajs/email-verification-dynamodb`](../email-verification-dynamodb/README.md): the other shared stores.
