# `@spinajs/orm-threading`

Database-backed `Mutex` for `@spinajs/threading`: named locks stored in the `__mutex__` table, shared by every process that uses the same database.

```ts
import { DI } from '@spinajs/di';
import { Mutex } from '@spinajs/threading';
import { OrmMutex } from '@spinajs/orm-threading';

DI.register(OrmMutex).as(Mutex);
```

## Documentation

- [Overview](../../docs/orm-threading/README.md)
- [Database mutex](../../docs/orm-threading/01-database-mutex.md)
- [Custom mutex backends](../../docs/orm-threading/02-custom-mutex-backends.md)
- [Mutex table and migration](../../docs/orm-threading/03-mutex-table-and-migration.md)
