# `@spinajs/orm-sqlite` documentation

The SQLite dialect driver, built on [`@spinajs/orm-sql`](../../orm-sql/docs/).

| | Page | Covers |
| --- | --- | --- |
| 01 | [Configuration](01-configuration.md) | Connection options, the read pool, in-memory databases |
| 02 | [Dialect notes](02-dialect-notes.md) | Feature support, type mapping, compiler overrides, limitations |

## Quick start

```bash
npm install @spinajs/orm @spinajs/orm-sqlite
```

```ts sample
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

export async function bootstrap() {
  DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  return await DI.resolve(Orm);
}
```

```ts sample
import { FrameworkConfiguration } from '@spinajs/configuration';
import _ from 'lodash';

export class AppConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      db: {
        DefaultConnection: 'sqlite',
        Connections: [
          {
            Name: 'sqlite',
            Driver: 'orm-driver-sqlite',
            Filename: './data/app.sqlite',
            Pool: { Max: 4 },
            Migration: { OnStartup: true },
          },
        ],
      },
    });
  }
}
```

## Why SQLite is the odd one out

Three things differ enough from the other drivers to be worth knowing up front:

- **`Pool.Max` sizes a pool of read-only handles**, not writers. SQLite serializes writers at the
  file level, so extra writer handles buy nothing and invite `SQLITE_BUSY`.
- **It is the only driver with `RETURNING` support** (`insertReturning: true`), which is how it
  reads generated keys back exactly — including from multi-row inserts.
- **`SERIALIZABLE` is the only isolation level**, because sqlite3 outside shared-cache mode
  serializes access to the file and that *is* SERIALIZABLE.

## Testing

The unit suite needs no server and runs everywhere:

```bash
cd packages/orm-sqlite && npm test
```

Integration tests create a temporary on-disk database and remove it afterwards:

```bash
npm run test:integration
```
