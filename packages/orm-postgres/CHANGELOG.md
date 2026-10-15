# @spinajs/orm-postgres changelog

## Unreleased

Verified against a live PostgreSQL 16 integration suite (`test/integration`, 107 tests).

### Breaking

- `dateTime` / `timestamp` columns are created as `TIMESTAMPTZ(3)`. Instants are written and read as UTC by the driver (a `DateTime` comes back in the UTC zone), every pooled session runs with `TimeZone = UTC`, and microseconds are truncated to milliseconds.
- Existing `TIMESTAMP` (without time zone) columns are read as UTC. Rows written by earlier versions from a process outside UTC read shifted by that zone's offset until the column is converted (README, "Upgrading `TIMESTAMP` columns created by earlier versions").
- A raw query returns a `DATE` value as a `Date` at UTC midnight of its calendar day (it used to be local midnight of the process zone).

### Fixed

- Joined tables are no longer qualified with the database name, and join key columns are quoted (U1-05).
- Relation `whereExist()` / `whereNotExists()` sub-queries and the static `Model.populate()` projection quote through the driver's quoter instead of hard-coded backticks (U1-04).
- `count()` and `selectCount()` return numbers; `COUNT(*)` is `bigint`, which node-postgres returns as a string (U1-01).
- Expression column defaults (`gen_random_uuid()`, `CURRENT_TIMESTAMP`) are left to the server instead of being inserted as literal text; literal defaults are read as values of the column type (U1-03).
- `insert(InsertBehaviour.InsertOrUpdate)` on a model targets the key, or the one unique column the row carries, instead of every unique column at once (U1-14).
- A JSON string value stored in a `jsonb` column reads back as that string (U1-08).
- `DateTime` columns compare correctly with `now()`, `DEFAULT CURRENT_TIMESTAMP` hydrates, and a timestamp read back can address its row by equality (U1-10 – U1-13).
- `dropColumn()` quotes the column name (U1-15).
- A server restart while a pooled client is checked out no longer crashes the process, a failed reconnect no longer leaves the driver without a pool, and a reconnect ends the previous pool (U1-16).

### Documented

- An explicit value into an identity key does not move the identity; run `setval` afterwards (U1-02, README dialect table).
- A failed statement aborts the surrounding transaction (`25P02`) unless it ran in a nested `transaction()` savepoint (README dialect table).
- `?` placeholders and the jsonb `?` operators (README dialect table).
