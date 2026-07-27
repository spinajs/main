# Schema and migrations

## Migrations

A migration extends `OrmMigration` and carries `@Migration(connectionName)`. The decorator
registers it under the `__migrations__` DI key.

### The name is data

The class name **must** end in `_yyyy_MM_dd_HH_mm_ss`, matched by
`/(.*)_([0-9]{4}_[0-9]{2}_[0-9]{2}_[0-9]{2}_[0-9]{2}_[0-9]{2})/`. The stamp is parsed with luxon
and used to order migrations. A name that does not match throws:

```
Migration file X have invalid name format ( invalid migration name, expected:
some_name_yyyy_MM_dd_HH_mm_ss got X )
```

### The three hooks

```ts sample
import { Migration, OrmMigration, OrmDriver, ReferentialAction } from '@spinajs/orm';

@Migration('default')
export class CreateShop_2026_07_27_10_00_00 extends OrmMigration {
  /**
   * Schema changes. Model classes are NOT usable here — the ORM has not wired
   * them up yet. Use the schema builder and raw queries only.
   */
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('clients', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Name', 128).notNull();
      table.dateTime('CreatedAt').notNull();
    });

    await connection.schema().createTable('orders', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.int('client_id').notNull();
      table.string('Reference', 64).notNull().unique();
      table.decimal('Total', 12, 2).notNull();

      table.foreignKey('client_id').references('clients', 'Id').onDelete(ReferentialAction.Cascade).onUpdate(ReferentialAction.Cascade);
    });
  }

  /** Undo `up`. */
  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('orders');
    await connection.schema().dropTable('clients');
  }

  /**
   * Data seeding. Runs AFTER the ORM has fully initialised, so models and
   * relations are available here.
   */
  public async data(): Promise<void> {
    // await Client.insert({ Name: 'Acme' });
  }
}
```

`up()` runs during `Orm.resolve()`, before models are wired — that is why `data()` exists as a
separate hook that runs afterwards, only for migrations applied in that same run.

### The lifecycle

For each connection, in migration-timestamp order:

1. Read `Migration.Table` (default `spinajs_migration`). If the table does not exist, create it
   with a unique `Migration` string column and a `CreatedAt` datetime.
2. Look for a row naming this migration.
3. `up()` runs only when **no** row exists; `down()` runs only when one **does**.
4. Wrap in a transaction when `Migration.Transaction.Mode === PerMigration`.
5. On `up`, insert the row; on `down`, delete it.

`migrateDown` reverses the order.

### Running them by hand

```ts sample
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';

export async function migrate() {
  const orm = await DI.resolve(Orm);

  // Everything pending. `force = true` (the default) ignores Migration.OnStartup.
  const applied = await orm.migrateUp();

  // Just one, by class name.
  await orm.migrateUp('CreateShop_2026_07_27_10_00_00');

  // Roll back.
  await orm.migrateDown('CreateShop_2026_07_27_10_00_00');

  return applied;
}
```

`migrateUp` resolves with the migrations it actually applied. During `Orm.resolve()` it is
called with `force = false`, so only connections with `Migration.OnStartup` are touched.

## The schema builder

`connection.schema()` returns a `SchemaQueryBuilder`.

| Method | Returns |
| --- | --- |
| `createTable(name, cb)` | `TableQueryBuilder` |
| `alterTable(name, cb)` | `AlterTableQueryBuilder` |
| `dropTable(name, schema?)` | `DropTableQueryBuilder` |
| `dropView(name, schema?)` | `DropViewQueryBuilder` |
| `cloneTable(cb)` | `CloneTableQueryBuilder` |
| `tableExists(name, schema?)` | `Promise<boolean>` |
| `event(name)` / `dropEvent(name)` | `EventQueryBuilder` / `DropEventQueryBuilder` |
| `raw(query, bindings?)` | `RawSchemaQueryBuilder` |

Every builder is thenable — `await` it to run it.

## Creating a table

### Column types

Each `ColumnType` value becomes a method on `TableQueryBuilder`, installed onto the prototype at
module load.

| Group | Methods |
| --- | --- |
| Integers | `tinyint` `smallint` `mediumint` `int` `bigint` |
| Text | `tinytext` `text` `mediumtext` `longtext` `string(name, length?)` |
| Numeric | `float(name, precision?, scale?)` `double(...)` `decimal(...)` |
| Boolean | `boolean` `bit` |
| Temporal | `date` `time` `dateTime` `timestamp` |
| Structured | `enum(name, values)` `json` `set(name, allowed)` |
| Binary | `binary(name, size)` `tinyblob` `mediumblob` `longblob` |

Two shorthands:

- `increments(name)` — `int(name).autoIncrement().notNull().primaryKey()`
- `uuid(name)` — `binary(name, 16)`, matching what `UuidConverter` writes

### Column modifiers

Every column method returns a `ColumnQueryBuilder`:

`notNull()` `unique()` `unsigned()` `autoIncrement()` `primaryKey()` `comment(text)`
`charset(cs)` `collation(c)` `default()`.

`default()` returns a `DefaultValueBuilder` with `value(v)`, `date()`, `dateTime()` and
`raw(query)`.

```ts sample
import { Migration, OrmMigration, OrmDriver, RawQuery } from '@spinajs/orm';

@Migration('default')
export class CreateProducts_2026_07_27_11_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('products', (table) => {
      table.increments('Id');
      table.uuid('PublicId').notNull().unique();

      table.string('Sku', 64).notNull().unique().comment('Stock keeping unit');
      table.string('Name', 255).notNull();
      table.text('Description');

      table.decimal('Price', 12, 2).notNull().unsigned();
      table.int('Stock').notNull().unsigned().default().value(0);

      table.enum('Status', ['draft', 'live', 'retired']).notNull().default().value('draft');
      table.set('Tags', ['new', 'sale', 'clearance']);
      table.json('Attributes');

      table.dateTime('CreatedAt').notNull().default().dateTime();
      table.dateTime('UpdatedAt');
      table.dateTime('DeletedAt');

      table.string('Slug', 255).default().raw(RawQuery.create("''"));

      table.comment('Catalogue products');
      table.charset('utf8mb4');
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('products');
  }
}
```

### Table-level options

| Method | Effect |
| --- | --- |
| `ifExists()` | Emit `IF NOT EXISTS` semantics for the create. |
| `temporary()` | Create a temporary table. |
| `trackHistory()` | Turn on history tracking — every change and row is versioned, readable through `@Historical` and `IHistoricalModel`. |
| `comment(text)` | Table comment. |
| `charset(cs)` | Table charset. |

### Composite primary keys

Mark each key column with `primaryKey()`. Dialects that cannot express a composite key inline —
SQLite — clear `InlinePrimaryKey` on the column builders and emit a table-level constraint
instead. That is handled for you.

```ts sample
import { Migration, OrmMigration, OrmDriver } from '@spinajs/orm';

@Migration('default')
export class CreateTenantRecords_2026_07_27_12_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('composite_table', (table) => {
      table.int('TenantId').notNull().primaryKey();
      table.string('Code', 32).notNull().primaryKey();
      table.string('Name', 128).notNull();
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('composite_table');
  }
}
```

## Foreign keys

`table.foreignKey(column)` returns a `ForeignKeyBuilder`.

| Method | Effect |
| --- | --- |
| `references(table, column)` | The parent table and column. |
| `onDelete(action)` | `ReferentialAction`. |
| `onUpdate(action)` | `ReferentialAction`. |
| `cascade()` | `onDelete(Cascade)` + `onUpdate(Cascade)`. |

`ReferentialAction`: `Cascade`, `SetNull`, `Restrict`, `NoAction` (default), `SetDefault`.

```ts sample
import { Migration, OrmMigration, OrmDriver, ReferentialAction } from '@spinajs/orm';

@Migration('default')
export class CreateOrderItems_2026_07_27_13_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('order_items', (table) => {
      table.increments('Id');
      table.int('order_id').notNull();
      table.int('product_id');

      table.foreignKey('order_id').references('orders', 'Id').cascade();
      table.foreignKey('product_id').references('products', 'Id').onDelete(ReferentialAction.SetNull);
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('order_items');
  }
}
```

## Indexes

Indexes come from the connection, not the table builder.

```ts sample
import { Migration, OrmMigration, OrmDriver } from '@spinajs/orm';

@Migration('default')
export class IndexOrders_2026_07_27_14_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.index().name('idx_orders_client').table('orders').columns(['client_id']);

    await connection.index().name('uq_orders_reference').table('orders').columns(['Reference']).unique();
  }

  public async down(_connection: OrmDriver): Promise<void> {
    // Drop through raw SQL — there is no dropIndex builder.
  }
}
```

## Altering a table

`AlterTableQueryBuilder` exposes the same column-type methods, each returning an
`AlterColumnQueryBuilder` with three modes.

| Method | Effect |
| --- | --- |
| `addColumn()` | Add the column. **The default.** |
| `modify()` | Change the existing column's definition. |
| `rename(newName)` | Rename it. |
| `after(column)` | Position it. |

Plus, on the table builder itself: `rename(newTableName)` and `dropColumn(column)`.

```ts sample
import { Migration, OrmMigration, OrmDriver } from '@spinajs/orm';

@Migration('default')
export class AlterProducts_2026_07_27_15_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('products', (table) => {
      table.string('Barcode', 32).addColumn().after('Sku');
      table.string('Name', 512).modify();
      table.string('Description').rename('LongDescription');
      table.dropColumn('Obsolete');
    });

    await connection.schema().alterTable('products', (table) => {
      table.rename('catalogue_products');
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('catalogue_products', (table) => {
      table.rename('products');
    });
  }
}
```

`AlterTableQueryBuilder.toDB()` returns an **array** of compiled statements — most dialects need
one statement per alteration.

## Dropping and cloning

```ts sample
import { Migration, OrmMigration, OrmDriver } from '@spinajs/orm';

@Migration('default')
export class Housekeeping_2026_07_27_16_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('legacy_orders');
    await connection.schema().dropView('v_legacy').ifExists();

    // Structure only.
    await connection.schema().cloneTable((clone) => {
      clone.shallowClone('orders', 'orders_backup');
    });

    // Structure plus a filtered subset of the data.
    await connection.schema().cloneTable((clone) => {
      void clone.deepClone('orders', 'orders_2026', (query) => {
        query.where('CreatedAt', '>', '2026-01-01');
      });
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('orders_backup').ifExists();
    await connection.schema().dropTable('orders_2026').ifExists();
  }
}
```

`deepClone` is `async` and returns a promise of the builder; `void`-ing it inside a synchronous
callback, as above, is the usual shape.

Truncation lives on the driver and on the model, not on the schema builder:
`connection.truncate('table')` or `Model.truncate()`.

## Database events

Scheduled jobs inside the database engine. Only dialects whose `supportedFeatures().events` is
true support them — **MySQL and MSSQL do; SQLite does not.**

```ts sample
import { Migration, OrmMigration, OrmDriver, RawQueryStatement } from '@spinajs/orm';

@Migration('default')
export class ScheduleCleanup_2026_07_27_17_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    if (!connection.supportedFeatures().events) {
      return;
    }

    const event = connection.schema().event('purge_old_sessions');

    event.every().hour(1);
    event.comment('Delete sessions older than a day');
    event.do(connection.del().from('sessions').where('CreatedAt', '<', '2026-01-01'));

    await event;
  }

  public async down(connection: OrmDriver): Promise<void> {
    if (!connection.supportedFeatures().events) {
      return;
    }

    await connection.schema().dropEvent('purge_old_sessions');
  }
}
```

`EventQueryBuilder`:

| Method | Effect |
| --- | --- |
| `every()` | Returns an `EventIntervalDesc` — `second`, `minute`, `hour`, `month`, `year`. Repeats. |
| `fromNow()` | Same shape, but runs once at `now + interval`. |
| `at(dateTime)` | Run once at a specific luxon `DateTime`. |
| `do(sql)` | A `RawQueryStatement`, one `QueryBuilder`, or an array of them. |
| `comment(text)` | Documentation, passed to the engine. |

`ScheduleQueryBuilder` wraps the same thing with `create(name, cb)` and `drop(name)`.

## Raw DDL

For anything the builders do not cover.

```ts sample
import { Migration, OrmMigration, OrmDriver, RawQuery } from '@spinajs/orm';

@Migration('default')
export class RawDdl_2026_07_27_18_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().raw('CREATE VIEW v_active_orders AS SELECT * FROM orders WHERE Status = ?', ['open']);

    await connection.schema().raw(RawQuery.create('CREATE INDEX idx_orders_status ON orders (Status)'));
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropView('v_active_orders').ifExists();
  }
}
```

## Reflecting an existing schema

`driver.tableInfo(name, schema?)` returns `IColumnDescriptor[]`. `Orm.resolve()` calls it for
every model — it is what makes decorator-free properties into real columns.

```ts sample
import { DI } from '@spinajs/di';
import { OrmDriver } from '@spinajs/orm';

export async function reflect() {
  const driver = DI.resolve<OrmDriver>('OrmConnection', ['default'])!;

  const exists = await driver.schema().tableExists('orders', driver.Options.Database);
  const columns = exists ? await driver.tableInfo('orders', driver.Options.Database) : [];

  return columns.map((c) => ({
    name: c.Name,
    type: c.Type,
    native: c.NativeType,
    nullable: c.Nullable,
    key: c.PrimaryKey,
  }));
}
```

## Model JSON schema

After reflection, each descriptor's `Schema` holds a JSON schema built by
`buildModelJsonSchema`. `Ignore` columns are excluded and relations omitted; a column is
`required` when it is neither nullable nor auto-increment.

| SQL type | JSON schema |
| --- | --- |
| `tinyint` `smallint` `mediumint` `int` `bigint` | `{ type: 'integer' }` |
| `decimal` `float` `double` `bit` | `{ type: 'number' }` |
| `boolean` | `{ type: 'boolean' }` |
| `date` | `{ type: 'string', format: 'date' }` |
| `dateTime` `timestamp` | `{ type: 'string', format: 'date-time' }` |
| `json` | `{ type: 'object' }` |
| `set` | `{ type: 'array', items: { type: 'string' } }` |
| anything else | `{ type: 'string' }` |

A column carrying `BooleanValueConverter` is forced to `boolean`. String columns gain
`maxLength` from `MaxLength`, `description` from `Comment`, and `nullable: true` when nullable.

```ts sample
import { Connection, Model, ModelBase, Primary, buildModelJsonSchema } from '@spinajs/orm';

@Connection('default')
@Model('products')
export class Product extends ModelBase<Product> {
  @Primary()
  public Id: number;

  public Sku: string;
}

export function schema() {
  const descriptor = Product.getModelDescriptor();

  // Already built during Orm.resolve(); rebuild it explicitly if you changed the columns.
  return { stored: descriptor.Schema, rebuilt: buildModelJsonSchema(descriptor) };
}
```

## Writing migrations that survive

- **Do not import models into `up()`.** They are not wired yet. Use `data()`.
- **Never edit an applied migration.** The recorded row keeps it from re-running; write a new one.
- **`down()` is not optional** — `migrateDown` calls it, and an empty `down()` silently corrupts
  the migration table.
- **Guard dialect-specific features** with `connection.supportedFeatures()`.
- **Timestamps order execution**, not file names or discovery order.
