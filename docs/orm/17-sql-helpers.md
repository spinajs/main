# SQL helpers

Small functions for stores that talk to a connection directly (`driver.select()`, `driver.insert()`, …) instead of through models. They cover what every such store repeats: counting affected rows, building SQL with bindings, matching composite keys, and writing or purging rows in batches that stay under the driver's parameter limits.

All of them are exported from `@spinajs/orm`. None of them asks which database it runs on. What differs between databases is the driver's job: duplicate keys reject with `ResourceDuplicated`, statement limits come from the driver, and SQL that each dialect spells its own way comes from the connection's `SqlExpressions`.

| Helper | What it does |
| --- | --- |
| `rowsAffected(result)` | `RowsAffected` of a write result; `0` when the driver reports no number |
| `sql` | Tagged template that builds a `SqlFragment` (`{ sql, bindings }`), plus `sql.raw`, `sql.join`, `sql.and`, `sql.or`, `sql.TRUE`, `sql.FALSE` |
| `isSqlFragment(value)` | Type guard for a `SqlFragment` |
| `toRawQuery(fragment)` | A `RawQuery` for `where()`, `select()` and the other builder methods that take one |
| `whereInGroups(query, groupColumn, column, groups)` | Composite-key `IN` without row values |
| `insertChunked(driver, table, rows, rowsPerStatement?)` | Multi-row insert split into statements under the parameter limits |
| `deleteChunked(driver, table, column, values, { where?, size? })` | `DELETE … WHERE column IN (…)` split into statements |
| `purgeBatch(driver, { table, key, where, limit? })` | Deletes up to one batch of matching rows |
| `everyNthCall(n)` | A counter that is `true` on every `n`-th call |
| `bumpVersionRow(driver, table, key, column?)` | Atomic `column = column + 1` on a version row, created at `0` when absent |
| `SqlExpressions` | Per-dialect SQL for a cast to text, a datetime as text, a substring test and a byte-exact comparison; resolved from the connection |

## How it works

### Affected rows

`rowsAffected()` returns `0` when the result has no numeric `RowsAffected`. A conditional write such as "revoke if not yet revoked" therefore reads an unknown count as "nothing happened", never as success.

### Duplicate keys

A statement that breaks a unique or primary key constraint rejects with `ResourceDuplicated` (from `@spinajs/exceptions`), its `inner` the error the driver wrapped. Each driver recognises its own server's signal; other constraint failures (`NOT NULL`, `CHECK`, foreign keys) stay `OrmException`.

| Driver | Signal |
| --- | --- |
| PostgreSQL | `code === '23505'` |
| MySQL | `errno === 1062` |
| MSSQL | `number === 2627` (key or constraint) or `2601` (unique index) |
| SQLite | `SQLITE_CONSTRAINT` with `UNIQUE constraint failed` (primary keys report the same text) |

A driver that does not override `isUniqueViolation()` recognises nothing: its violations reject as it threw them.

### Dialect expressions

`driver.Container.resolve(SqlExpressions)` returns the connection's `SqlExpressions`. Each driver registers its own in `resolve()`. A string argument is SQL without bindings, such as a quoted column; a `SqlFragment` argument carries its bindings into the result.

| Method | Returns | SQLite | PostgreSQL | MySQL | MSSQL |
| --- | --- | --- | --- | --- | --- |
| `castText(expression, length?)` | `expression` as text; `length` bounds the type where the dialect needs one | `CAST(x AS TEXT)` | `CAST(x AS TEXT)` | `CAST(x AS CHAR[(n)])` | `CAST(x AS NVARCHAR(n \| MAX))` |
| `datetimeText(expression)` | A datetime column as the wall-clock text it stores, `yyyy-MM-dd HH:mm:ss[.SSS]`, never shifted into a zone | `x` (stored as text) | `CAST(x AS TEXT)` | `CAST(x AS CHAR)` | `CONVERT(varchar(23), x, 121)` |
| `contains(haystack, needle)` | `SqlFragment`, true where `needle` occurs in `haystack` | `instr(h, n) > 0` | `strpos(h, n) > 0` | `LOCATE(n, h) > 0` | `CHARINDEX(n, h) > 0` |
| `equalsExactly(left, right)` | `SqlFragment`, `left = right` byte for byte, whatever the column collation | `l = r` | `l = r` | `l = CAST(r AS BINARY)` | `l = r COLLATE Latin1_General_BIN2` plus a `LEN(… + 'x')` check for trailing spaces; binds `right` twice |

The base `SqlExpressions` throws `NotSupported` from every method, so a driver that registers none fails loudly instead of emitting another dialect's SQL. To add or fix one, subclass a shipped implementation and register it `.as(SqlExpressions)` in the driver's `resolve()`; see [Adding a new SQL dialect](../orm-sql/07-adding-a-sql-dialect.md).

Use `datetimeText()` to read a datetime column when the driver would parse it in a zone: `node-postgres` reads `timestamp` in the process zone, and `tedious` reads it as UTC. Use `equalsExactly()` where a match must not fold case, such as a secret or a token, on a column declared without [`exact()`](09-schema-builder.md#exact-columns).

### SQL fragments

In `` sql`…` `` a nested fragment is inlined with its bindings, an array becomes `?, ?, …`, and any other value becomes one `?`. An empty array throws `InvalidArgument`, because `IN ()` is not valid SQL. Identifiers are never quoted: pass them through `sql.raw()` or quote them with the driver's `IdentifierQuoter`.

`sql.and()` and `sql.or()` wrap each part in parentheses. One part is returned as is. No parts gives `sql.TRUE` (`1 = 1`) for `and` and `sql.FALSE` (`1 = 0`) for `or`. Neither uses boolean literals, which MSSQL lacks.

### Composite keys

Row-value `(a, b) IN ((?, ?), …)` is not portable. `whereInGroups()` adds one where group of the form `(groupColumn = ? AND column IN (…)) OR …`, one branch per map entry. Entries with no values are skipped. When nothing is left the group is `1 = 0`, so the query matches no rows.

### Batches

Each driver declares its server's limits as `MaxBindings` (parameters per statement) and `MaxInsertRows` (rows per `VALUES` list); a driver that declares none has no limit. `insertChunked()` picks `min(MaxInsertRows, floor(MaxBindings / columns))` rows per statement from the widest row, and `deleteChunked()` binds `min(IN_CHUNK, MaxBindings)` values per statement (`IN_CHUNK` is 1000). Both run the statements in order and return the summed `rowsAffected()`.

`purgeBatch()` runs two statements:

1. It selects up to `limit` (default 500) values of `key` from the rows `where` matches, ordered by `key`.
2. It deletes the rows with those keys that `where` still matches, so a row that changed in between stays.

Pair it with `everyNthCall()` to purge from a hot path now and then instead of on a timer.

### Version rows

`bumpVersionRow()` inserts `{ ...key, [column]: 0 }` with `orIgnore()`, then runs one `UPDATE … SET column = column + 1 WHERE …`. The increment is a single statement, so concurrent bumps never lose a count. Call it inside the caller's transaction when the bump must commit with the change it versions.

## Usage

```ts sample
import { ResourceDuplicated } from '@spinajs/exceptions';
import { IdentifierQuoter, OrmDriver, SqlExpressions, everyNthCall, insertChunked, purgeBatch, rowsAffected, sql, toRawQuery, whereInGroups } from '@spinajs/orm';

const purgeNow = everyNthCall(64);

export async function claim(driver: OrmDriver, key: string, expiresAt: Date, now: Date): Promise<boolean> {
  if (purgeNow()) {
    await purgeBatch(driver, {
      table: 'nonce',
      key: 'k',
      where: function () {
        this.where('expires_at', '<=', now);
      },
    });
  }
  try {
    await driver.insert().into('nonce').values({ k: key, expires_at: expiresAt });
    return true;
  } catch (err) {
    if (!(err instanceof ResourceDuplicated)) throw err;
  }
  // Take over an expired claim; an unknown row count is not a win.
  return rowsAffected(await driver.update().in('nonce').update({ expires_at: expiresAt }).where('k', key).where('expires_at', '<=', now)) === 1;
}

interface Edge {
  parent_type: string;
  parent_id: string;
  child_id: string;
}

export async function copyEdges(driver: OrmDriver, edges: Edge[]): Promise<number> {
  return insertChunked(driver, 'edge', edges);
}

export async function edgesOf(driver: OrmDriver, parents: Map<string, string[]>): Promise<Edge[]> {
  return whereInGroups(driver.select<Edge[]>().from('edge'), 'parent_type', 'parent_id', parents);
}

export async function visible(driver: OrmDriver, owner: string, teams: string[]): Promise<{ id: number }[]> {
  const where = sql.or([sql`owner_id = ${owner}`, ...(teams.length ? [sql`team_id IN (${teams})`] : [])]);
  return driver.select<{ id: number }[]>().from('document').where(toRawQuery(where));
}

// Confirm a pending MFA enrolment only for the exact secret it was started with; MySQL and MSSQL collations ignore case.
export async function confirmEnrolment(driver: OrmDriver, identity: string, secretEnc: string, at: Date): Promise<boolean> {
  const column = driver.Container.resolve(IdentifierQuoter).quote('secret_enc');
  const same = driver.Container.resolve(SqlExpressions).equalsExactly(column, sql`${secretEnc}`);
  return rowsAffected(await driver.update().in('mfa').update({ confirmed_at: at }).where('identity', identity).whereNull('confirmed_at').where(toRawQuery(same))) === 1;
}
```
