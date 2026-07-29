# `@spinajs/orm-mysql` documentation

The MySQL / MariaDB dialect driver, built on [`@spinajs/orm-sql`](../../orm-sql/docs/). Ships two
drivers: `MySqlOrmDriver` and `MySqlSSHOrmDriver`, which tunnels the connection over SSH.

| | Page | Covers |
| --- | --- | --- |
| 01 | [Configuration](01-configuration.md) | Connection options, pooling, SSH tunnelling |
| 02 | [Dialect notes](02-dialect-notes.md) | Feature support, the contiguous-key guarantee, overrides |

## Quick start

```bash
npm install @spinajs/orm @spinajs/orm-mysql
```

```ts sample
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import { MySqlOrmDriver } from '@spinajs/orm-mysql';

export async function bootstrap() {
  DI.register(MySqlOrmDriver).as('orm-driver-mysql');
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
        DefaultConnection: 'mysql',
        Connections: [
          {
            Name: 'mysql',
            Driver: 'orm-driver-mysql',
            Host: '127.0.0.1',
            Port: 3306,
            User: 'app',
            Password: 'secret',
            Database: 'app',
            Encoding: 'utf8mb4',
            Pool: { Min: 2, Max: 20 },
            Migration: { OnStartup: true },
          },
        ],
      },
    });
  }
}
```

## What is distinctive here

- **`insertIdIsFirstOfBatch: true`** — the only driver where it holds. A multi-row insert's
  generated keys can be read as `LAST_INSERT_ID() + index`. See
  [02-dialect-notes.md](02-dialect-notes.md).
- **No `RETURNING`.** `InsertQueryBuilder.returning()` throws `NotSupported`.
- **Database events are supported**, unlike SQLite.
- **All four isolation levels** are honoured.
- **Retries are suppressed inside a transaction** — the driver overrides `isRetryableError` to
  say so explicitly.

## Testing

Unit tests need no server:

```bash
cd packages/orm-mysql && npm test
```

Integration tests need the container from the repository root:

```bash
docker compose --profile test up -d mysql
docker compose ps                      # wait for the healthcheck
cd packages/orm-mysql && npm run test:integration
```

The container publishes MySQL on host port **13306**, deliberately not 3306, so it cannot collide
with a local MySQL. See the [repository README](../../../README.md) for the environment variables
the suite reads.
