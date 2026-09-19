# ORM view and event query builders - design

Date: 2026-09-19
Status: approved design, not implemented

## Problem

`@spinajs/orm` can drop a view (`schema().dropView()`) but cannot create one, so consumers
create views through `schema().raw(new RawQuery('CREATE ... VIEW ...'))`. Database events
(scheduled jobs) do have a builder, but it is unusable in practice and consumers bypass it with
raw SQL as well:

- the event name is interpolated unquoted;
- `at()` formats with `yyyy-mm-dd`, where `mm` is minutes, and emits the timestamp unquoted;
- an interval keeps only the first positive field of `EventIntervalDesc`, and has no DAY or WEEK;
- no `STARTS`, `ENDS`, `ON COMPLETION`, `ENABLE | DISABLE`, `IF NOT EXISTS`;
- `every()`, `at()`, `do()`, `comment()` do not chain;
- `ScheduleQueryBuilder` is not reachable from the driver;
- there are no tests.

Nothing in `yourscreen-backend` or `sn-step-schedules` calls the event builder, so it can be
reworked without a compatibility layer.

`yourscreen-backend` issues 16 `CREATE VIEW` and 11 `CREATE EVENT` statements through raw
queries. The clauses it needs:
`CREATE OR REPLACE VIEW`, `ALGORITHM=`, `SQL SECURITY DEFINER | INVOKER`, schema-qualified names;
`EVERY n MINUTE | HOUR | DAY | WEEK`, `STARTS`, `ON COMPLETION [NOT] PRESERVE`, `ENABLE`,
`COMMENT`, multi-statement `BEGIN ... END` bodies.

## Goals

1. A `CreateViewQueryBuilder` with the usual builder / abstract compiler / SQL compiler / driver
   registration split, working on mysql, sqlite, postgres and mssql.
2. The event builder reworked into a usable fluent API. MySQL only.
3. A feature an engine does not have is never simulated. The compiler throws
   `MethodNotImplemented` naming the engine and the clause.
4. `yourscreen-backend` migrations converted from raw queries to the new builders, with proof
   that the resulting database objects are unchanged.

## Non-goals

- Simulating anything: no `DROP` + `CREATE` for a missing `OR REPLACE`, no Node.js timers for
  engines without events, no SQL Server Agent jobs.
- `ALTER VIEW`, `ALTER EVENT`, materialized views, `DEFINER = user`, `viewExists()`.
- Rewriting backend view/event bodies as builder calls. They stay `RawQuery`.
- Fixing the brute-force `?` replacement in the postgres and mssql `executeOnDb` (see Known
  limits).

## Architecture

One abstract compiler per statement in `packages/orm/src/interfaces.ts`, a shared SQL compiler in
`packages/orm-sql/src/compilers.ts`, one subclass per driver, registered in that driver's
`resolve()`.

The shared view compiler emits only the portable core and **throws `MethodNotImplemented` for
every optional clause**. A driver subclass overrides the hook of each clause its engine really
has. A clause nobody thought about for an engine therefore throws instead of leaking another
dialect's SQL. The view compiler is NOT registered in the shared `SqlDriver.resolve()`; each
driver registers its own, per the existing rule that nothing dialect-specific is inherited.

View and event compilers always return `bindings: []`. Values are inlined as literals (next
section).

### Literal inlining

No engine accepts parameters inside `CREATE VIEW`. MySQL only appears to because `mysql2`
interpolates client-side; sqlite, postgres and mssql reject the statement. `CREATE EVENT` is not
preparable either. So a body built with `select.where('isDeleted', 0)` must reach the engine with
the `0` written into the SQL.

New service in `packages/orm/src/quoting.ts`, mirroring `IdentifierQuoter`:

```ts
@NewInstance()
export abstract class LiteralQuoter {
  public abstract quote(value: unknown): string;
}
```

No default registration. Each driver registers its own:

| driver   | class                   | strings                  | booleans       |
|----------|-------------------------|--------------------------|----------------|
| sqlite   | `SqlLiteralQuoter`      | `'...'`, `'` doubled     | `1` / `0`      |
| mysql    | `MySqlLiteralQuoter`    | `mysql2.escape()`        | `1` / `0`      |
| postgres | `PostgresLiteralQuoter` | `pg.escapeLiteral()`     | `TRUE`/`FALSE` |
| mssql    | `MsSqlLiteralQuoter`    | `N'...'`, `'` doubled    | `1` / `0`      |

`SqlLiteralQuoter` lives in orm-sql (new file `src/literals.ts`) and is the plain ANSI spelling;
sqlite claims it explicitly, the other three subclass it and override `quoteString()` and / or
`quoteBoolean()`. Common rules live once in it: `null` / `undefined` give `NULL`; a
finite `number` and a `bigint` are written as-is, a non-finite number throws; `Date` and luxon
`DateTime` go through the `DatetimeValueConverter` registered in the driver container and are then
quoted as a string; any other type (object, array, Buffer) throws `InvalidArgument`.

Helper in orm-sql:

```ts
export function inlineBindings(expression: string, bindings: unknown[], quoter: LiteralQuoter): string
```

It walks the expression and replaces each `?` with the next quoted binding, skipping `'...'`,
`"..."`, `` `...` ``, `-- ...` line comments and `/* ... */` block comments. A doubled quote
inside a quoted region is an escaped quote; a backslash is NOT treated as an escape, and `[...]`
is not treated as quoting (it is array syntax in postgres). It throws `InvalidOperation` when the
placeholder count and the binding count differ. With no bindings the expression is returned
untouched.

## Views

### API

```ts
await connection.schema().createView('campaign_view', (view) => {
  view
    .database('arrow4')
    .orReplace()
    .columns(['id', 'name'])
    .algorithm('UNDEFINED')
    .security('DEFINER')
    .checkOption('CASCADED')
    .as((select) => select.from('arrow_campaign').where('isDeleted', 0));
});
```

`CreateViewQueryBuilder extends QueryBuilder`, `QueryContext.Schema`, name set through
`setTable()`, qualified through the inherited `database()`.

| method | state | notes |
|---|---|---|
| `as(body)` | `Body` | `(select: SelectQueryBuilder) => void`, a `SelectQueryBuilder`, or a `RawQuery`. Required; compiling without it throws `InvalidOperation`. |
| `orReplace()` | `Replace` | |
| `ifNotExists()` | `IfNotExists` | |
| `columns(names)` | `Columns` | explicit view column list |
| `algorithm(a)` | `Algorithm` | `'UNDEFINED' \| 'MERGE' \| 'TEMPTABLE'` |
| `security(s)` | `Security` | `'DEFINER' \| 'INVOKER'` |
| `checkOption(o?)` | `CheckOption` | `'CASCADED' \| 'LOCAL'`, or no argument for the plain form |
| `temporary()` | `Temporary` | |

`SchemaQueryBuilder.createView(name, callback)` follows `createTable`: builds, runs the callback,
returns the thenable builder. `dropView()` is unchanged.

### Dialect matrix

| clause | mysql | sqlite | postgres | mssql |
|---|---|---|---|---|
| core, column list | yes | yes | yes | yes |
| `orReplace()` | `CREATE OR REPLACE VIEW` | throws | `CREATE OR REPLACE VIEW` | `CREATE OR ALTER VIEW` |
| `ifNotExists()` | throws | `IF NOT EXISTS` | throws | throws |
| `algorithm()` | `ALGORITHM=x` | throws | throws | throws |
| `security()` | `SQL SECURITY x` | throws | `WITH (security_invoker = true \| false)` | throws |
| `checkOption()` | all forms | throws | all forms | plain form only, `CASCADED` / `LOCAL` throw |
| `temporary()` | throws | `CREATE TEMP VIEW` | `CREATE TEMPORARY VIEW` | throws |

"throws" is `MethodNotImplemented('<engine> does not support <clause> on CREATE VIEW')`.

MSSQL additionally throws when `Database` is set: T-SQL forbids a database prefix on the view
name. Postgres `security_invoker` needs PostgreSQL 15 or newer (the test fixture runs 16.6).

### Compiler shape

`SqlCreateViewQueryCompiler extends CreateViewCompiler`. `compile()` assembles, in this order,
from protected hooks:

```
CREATE <_replace()> <_temporary()> <_prefixOptions()> VIEW <_ifNotExists()> <_name()> <_columns()> <_withOptions()> AS <_body()> <_checkOption()>
```

- `_replace()`, `_temporary()`, `_ifNotExists()`, `_checkOption()` - return `''` when the clause
  was not requested and throw in the shared compiler when it was;
- `_prefixOptions()` - clauses between `CREATE` and `VIEW` (mysql `ALGORITHM=`, `SQL SECURITY`);
- `_withOptions()` - clauses between the column list and `AS` (postgres `WITH (security_invoker = ...)`);
  the shared versions of both throw when `Algorithm` or `Security` is set;
- `_name()` through `TableAliasCompiler`, `_columns()` through `IdentifierQuoter`;
- `_body()` - `toDB()` of the select, or the raw query, then `inlineBindings`.

Drivers: `MySqlCreateViewCompiler`, `SqliteCreateViewCompiler`, `PostgresCreateViewCompiler`,
`MsSqlCreateViewCompiler`. MSSQL overrides `_replace()` to turn the head into `CREATE OR ALTER`.

## Events

### API

```ts
await connection.schema().createEvent('update_status', (event) => {
  event
    .every(5, 'MINUTE') // or .at(DateTime) or .fromNow(1, 'DAY')
    .starts(DateTime.fromSQL('2025-11-21 05:27:43'))
    .ends(someDateTime)
    .preserve()
    .disabled()
    .ifNotExists()
    .comment('keeps player content status in sync')
    .do(new RawQuery('UPDATE ...'));
});

await connection.schema().dropEvent('update_status').ifExists();
```

Changes to the existing classes, in place:

- `EventIntervalDesc` is removed. Intervals are `(value: number, unit: EventIntervalUnit)` with
  `EventIntervalUnit = 'YEAR' | 'QUARTER' | 'MONTH' | 'WEEK' | 'DAY' | 'HOUR' | 'MINUTE' | 'SECOND'`.
  `value` must be a positive integer, otherwise `InvalidArgument`.
- Every method returns `this`.
- `every`, `at` and `fromNow` are mutually exclusive; setting a second one throws
  `InvalidOperation`. `starts` / `ends` are only valid with `every`.
- The name is set through `setTable()` and can be qualified with the inherited `database()`; the
  `Name` property is gone.
- `do()` takes `RawQuery | QueryBuilder | (RawQuery | QueryBuilder)[]`. `RawQueryStatement` is
  no longer accepted: it is a container-resolved statement, not something a caller holds.
- `EventQueryCompiler` and `DropEventQueryCompiler` declared `compile(): ICompilerOutput[]` while
  the implementations returned a single output; the abstractions now say `ICompilerOutput`.
- Default `ON COMPLETION NOT PRESERVE` and `ENABLE` are emitted explicitly.
- `DropEventQueryBuilder` gains `ifExists()`; `IF EXISTS` is emitted only when it was called,
  like `dropTable` and `dropView`. It used to be unconditional.
- `SchemaQueryBuilder.event(name)` becomes `createEvent(name, callback)`.
- `ScheduleQueryBuilder` is deleted.

### Compiled SQL

```sql
CREATE EVENT [IF NOT EXISTS] `name`
ON SCHEDULE EVERY 5 MINUTE [STARTS '...'] [ENDS '...']
          | AT '...'
          | AT CURRENT_TIMESTAMP + INTERVAL 1 DAY
ON COMPLETION [NOT] PRESERVE
ENABLE | DISABLE
[COMMENT '...']
DO <statement>
```

The name goes through `TableAliasCompiler` (so through `IdentifierQuoter`), timestamps and the
comment through `LiteralQuoter`, body bindings through `inlineBindings`.

Body: exactly one action is emitted as given after `DO` - a single statement, or a `RawQuery`
that carries its own `BEGIN ... END` block. Several actions are wrapped:

```sql
DO BEGIN
<statement>;
<statement>;
END
```

each statement on its own line with a `;` appended unless it already ends in one, and `END` on
a line of its own. The builder does not parse SQL: a single `RawQuery` holding several
statements without its own `BEGIN ... END` is the caller's error and the engine rejects it.

### Engines without events

sqlite, postgres and mssql register `UnsupportedEventQueryCompiler` and
`UnsupportedDropEventQueryCompiler` (defined once in orm-sql, claimed explicitly by each driver).
Both throw `MethodNotImplemented('<driver> has no native scheduled events')` from `compile()`.
`supportedFeatures().events` stays the source of truth for callers that want to check first; a
test pins the flag to the compiler behaviour for every driver.

## Testing

Spinajs, TDD, per package:

- `orm-sql`: `inlineBindings` (quoted regions, count mismatch, no bindings), the shared literal
  rules, the shared view compiler core and its throwing defaults.
- each driver, no DB, in a new `test/view.test.ts`: registrations of `CreateViewCompiler` and
  `LiteralQuoter`; one assertion per cell of the dialect matrix, exact SQL or
  `MethodNotImplemented`; literal quoting including `'; DROP TABLE x; --` and, for mysql, a
  backslash. Event registrations and the unsupported-event throws go into the existing
  `test/dialect.test.ts`.
- `orm-mysql` `test/event.test.ts`: mysql-quoted event SQL; every clause and the validation
  errors are covered once, in `orm-sql/test/event.test.ts`.
- `orm-sqlite` live, in memory: create a view whose body carries a binding, select from it,
  drop it.
- `orm-mysql` and `orm-mssql` live suites: create / select / drop a view, create / drop an
  event (mysql), behind the same guards the existing live tests use.
- Docs: a views section and a rewritten events section in
  `packages/orm/docs/10-schema-and-migrations.md`.

## Delivery

Stage 1 - spinajs. Branch `feat/orm-view-event-builders` off master, PR to `spinajs/main`. The
spec and plan files are dropped once the work has shipped, as was done for #178.

Stage 2 - yourscreen-backend. Separate branch and PR, developed against the locally rebuilt
spinajs through the existing `node_modules/@spinajs` junctions; it can merge only after spinajs
publishes and the backend bumps its `@spinajs/*` versions.

Each stage gets its own implementation plan.

Files to convert - the migrations under `packages/backend/src/migrations` that still execute
and issue `CREATE ... VIEW`, `DROP VIEW`, `CREATE EVENT` or `DROP EVENT` through `schema().raw()`:
`baseline/views.ts`, `baseline/{arrow4,gracjan,materialized-views,rtb,yourscreen}/events.ts`
(including the `recreateNetworkOccupancyEvent` helper), the matching five `dropAll.ts`,
`CampaignScheduleToInvoiceView_*` and `CampaignFileAttachment_*`.

Excluded: the five files under `prod/`. They have already run in production, never run again,
and cannot be verified by execution (two of them also use `STARTS CURRENT_TIMESTAMP`, which the
builder does not model). They keep their raw SQL.
Bodies stay verbatim inside `RawQuery`; only the DDL wrapper moves to the builder. Explicit
defaults (`ALGORITHM=UNDEFINED`, `SQL SECURITY DEFINER`, `ON COMPLETION NOT PRESERVE`, `ENABLE`)
are kept explicit.

Equivalence proof: before the conversion run `db:reset` and dump
`information_schema.VIEWS (TABLE_SCHEMA, TABLE_NAME, VIEW_DEFINITION, SECURITY_TYPE, CHECK_OPTION)`
and `information_schema.EVENTS (EVENT_SCHEMA, EVENT_NAME, EVENT_DEFINITION, INTERVAL_VALUE,
INTERVAL_FIELD, STARTS, ENDS, STATUS, ON_COMPLETION, EVENT_COMMENT)`; repeat after the
conversion; the two dumps must be identical.

## Known limits

- The postgres and mssql drivers rewrite every `?` in a statement into a positional / named
  parameter inside `executeOnDb`, including one inside a string literal. A raw view body that
  contains a literal `?` therefore still breaks on those two engines. Pre-existing, affects
  `schema().raw()` equally, out of scope here.
- MSSQL rejects `ORDER BY` in a view body without `TOP`. That is the engine's rule about the
  body, not a clause of the builder, so the compiler does not police it.
