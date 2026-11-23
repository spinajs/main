# Limits

## What is not recorded

History records what the write capture of `@spinajs/orm` sees: statements built on a tracked model ([What the capture does not see](../orm/25-write-capture.md#what-the-capture-does-not-see)). Not recorded:

- Raw SQL, `RawQuery`, `TRUNCATE` (also `Model.truncate()`, which is built on the model), and builders without a model (`driver.insert()`, `driver.update()`, `driver.del()`).
- The orphan deletes of a relation's `sync()`, which run without a model: a one-to-many `sync()` deletes the child rows that left the relation, a many-to-many `sync()` the junction rows. A `@SoftDelete` child of a one-to-many relation is soft-deleted through its model instead, and recorded as `soft_delete`. When those rows are tracked, delete them through their model or the unit of work.
- Rows the database changes by itself (`ON DELETE CASCADE`, triggers) and writes of other services to the same database.
- Relations other than their foreign-key columns: a row's entry holds its own columns only.

## Keys

- **Single-column primary keys only.** A model with a composite key and its own `@History()` fails its first tracked write with `HistoryConfigError`; one matched only by a rule is left untracked with a warning.
- **A primary key change is refused.** An update that changes the key of a tracked row fails with `HistoryWriteError` (`orm-history: an update of <entity> writes its primary key <key column>; history is keyed by it, delete and insert the row instead`). The change is detected after the statement ran, when its row is gone under the old key. Outside a transaction of your own, the error rolls the statement back with the capture's transaction. Inside one, the statement has already run in it: only rolling that transaction back undoes the change, so let the error reach `transaction()`; a caller that catches it and commits keeps the new key, with no entry. An update that names the key with its unchanged value (`row.archive()`, `Model.update(row.toSql())`) is an ordinary update. An update that swaps keys among the rows it writes (`SET id = CASE ...`) is not detected: each key still exists, and it is recorded as an update of each.
- **Inserts whose keys are not reported** record a `lost` event instead of their rows, or fail with `audit.data.onUnknownKeys: 'throw'` ([Inserts whose keys are not reported](01-tracking-models.md#inserts-whose-keys-are-not-reported)).
- **Keys need a text.** The subject id is a string key as it is or an integer key in decimal. A key `@Uuid()` stores as bytes is refused: with the model's own `@History()` its first tracked write fails with `HistoryConfigError`, under a rule it is left untracked with a warning. Any other key with no text (bytes, a `Date`, a number that is not a safe integer) is found in two cases only. A plain insert that supplies such a key, or gets one back from the database, records a `lost` event with `reason: 'keys_without_text'`, or fails under `onUnknownKeys: 'throw'`. An upsert whose supplied key itself has no text is handled as an insert whose keys are not reported. History records nothing, and gives no warning, for:
  - an update or a delete of such rows;
  - an upsert that does not supply the key, unless the driver reports no key at all, which is handled as an insert whose keys are not reported;
  - an upsert that supplies the key as text that the database returns without text: a string for a `BIGINT` key above 2^53 on mysql2 without `supportBigNumbers`, or a string into a `VARBINARY` or `DATETIME` key.
- **The subject id is the key as the database returns it**, not as the write supplied it. A database can spell a key differently: a Postgres `uuid` comes back in lowercase, an MSSQL `uniqueidentifier` in uppercase. Read with that spelling: `Model.history().of(id)` with the spelling a caller supplied, or `row.history()` of a row inserted with it and not reloaded, finds nothing. A converter on the key must keep its text for the same reason: `row.history()` reads by the model's value, the event holds the stored one.

## Values

- `at` is the instant history recorded the statement, right after it ran, on the application's clock, one per statement, kept to the millisecond. It is not the commit time: entries of concurrent transactions can commit in another order than their `at`.
- An entry holds the row as the database returns it after the write, not as the write supplied it. A column that cannot hold a character keeps what it stored: an MSSQL `VARCHAR` column (`string()` without `exact()`, code page 1252) turns `Łukasz 東京` into `Lukasz ??`, and that is the value in the entry.
- Values are raw driver values. A JSON column is an object on Postgres, PGlite and MySQL and its text on sqlite and MSSQL, and `before` and `after` keep it that way. A column the model declares as JSON (`@Json()`, `@Column({ family: 'json' })`) is compared by value on every driver, so the same JSON with its keys in another order records no update. One it does not declare is compared as the driver returns it: on sqlite and MSSQL as text, where another key order is a change. The column type of the table does not declare it: sqlite reports none for a `json()` column. A declared JSON column whose text holds a number beyond double precision (more than 15 significant digits, `1e400`, `1e-400`) is compared as text; `-0` against `0` and a duplicate key (`{"a":1,"a":2}` against `{"a":2}`) count as no change.
- A JSON document nested deeper than the JavaScript stack allows (a few thousand levels) fails the tracked write on every dialect, with a `RangeError` or an `AuditConfigError` caused by one: where the driver parses JSON (Postgres, MySQL) when the payload is hashed, and on sqlite and MSSQL when an update compares a declared JSON column that holds it.
- The keys of `before`, `after` and an `asOf` row come back sorted (the payload is canonical JSON), not in the table's column order.
- A masked (`@Hidden()`) column is named in `changed` but its value is never stored; `hidden: 'record'` stores it.
- **Masking covers every model of the table.** A column is masked when any model class the ORM loaded on the same table and connection declares it `@Hidden()`, so `User.update({ ... })` masks the `twoFactorSecret` that only its subclass `AdminUser` hides. The same table means the same `@Model()` table name on the same connection, where `default` and an alias count as the connection they name: two spellings of one physical table (`users` and `Users`, `public.users` and `users`), or two configured connections to one database, do not share hidden columns. The masked columns are fixed per tracked model when its spec is built, at its first use: its first tracked write or its first `Model.history()` / `row.history()` read. A class the ORM registers after that is not seen until the spec is built again: after a restart, a new `registerHistory()` of the tracked model or, for a rule-tracked one, a new `audit.data.rules`.

## Order and connections

- `seq` orders the trail table of one connection. Entries of models on different connections are not one ordered stream, and no order between them is defined.
- Reads of a model cover its own connection only, where its writes recorded their events.
- A subject (`{ type: <entity>, id }`) has no connection in it, so models on different connections that share an entity name share subject ids: `forget` erases the rows of such a model on the trail's own connection with it, leaves one on a third connection alone, and the sweep `audit().trail(name).forget(subject)` erases the rows of each with that id. Give such models distinct `entity` names.

## Configuration

- A history trail needs a store that joins the write's transaction (`TableAuditStore`, `OutboxAuditStore`): the audit service refuses a tracked write to any other store with `AuditConfigError`, and the write is rolled back.
- A match-all rule (`models: '*'`) also covers the models of every package the application loads, framework models included. Opt one out with `registerHistory(Model, false)`.
- Installing the package changes nothing for an untracked model, apart from two migrations on the default connection: the package's `orm_history` and the `audit_event` of `@spinajs/audit-orm`, which the package imports. Until `npx spinajs migrate-up` has applied them, the application does not boot: with `db.MigrationCheck` at its default `'fail'`, `Orm.resolve()` rejects with `PendingMigrationsException` ([Who migrates the trail table](01-tracking-models.md#who-migrates-the-trail-table)). That import also registers the read-audit query middleware of `@spinajs/audit-orm`, which does nothing for a model without read auditing.

## Cost and access

- A tracked statement runs in a transaction with the capture's reads (a key select and the rows before and after it, by key) and one insert into the trail table.
- Its size follows the statement: an update or delete without a narrow `where` reads every row it reaches into memory, before and after, and hands them to the trail in one record. `db.WriteCapture.MaxRows` bounds it, and is unlimited by default ([Write capture](../orm/25-write-capture.md#limits)).
- Reads apply no authorization scoping: whoever may call `Model.history()` or `historyOf()` reads every entry of the model. An application that exposes them decides who may call them.
