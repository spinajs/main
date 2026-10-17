# SQL helpers

Small functions for stores that talk to a connection directly (`driver.select()`, `driver.insert()`, …) instead of through models. They cover what every such store repeats: reading the dialect, counting affected rows, recognising a duplicate key, building SQL with bindings, matching composite keys, and writing or purging rows in batches that stay under every driver's parameter limit.

All of them are exported from `@spinajs/orm` and work on SQLite, PostgreSQL, MySQL and MSSQL.

| Helper | What it does |
| --- | --- |
| `driverDialect(driver)` | `'sqlite' \| 'postgres' \| 'mysql' \| 'mssql' \| 'other'`, from the driver class chain, else from the registered driver name |
| `rowsAffected(result)` | `RowsAffected` of a write result; `0` when the driver reports no number |
| `isUniqueViolation(err)` | `true` for a unique or primary key violation, also when wrapped in `inner`, `cause` or `originalError` |
| `sql` | Tagged template that builds a `SqlFragment` (`{ sql, bindings }`), plus `sql.raw`, `sql.join`, `sql.and`, `sql.or`, `sql.TRUE`, `sql.FALSE` |
| `isSqlFragment(value)` | Type guard for a `SqlFragment` |
| `toRawQuery(fragment)` | A `RawQuery` for `where()`, `select()` and the other builder methods that take one |
| `whereInGroups(query, groupColumn, column, groups)` | Composite-key `IN` without row values |
| `insertChunked(driver, table, rows, rowsPerStatement?)` | Multi-row insert split into statements under the parameter limits |
| `deleteChunked(driver, table, column, values, { where?, size? })` | `DELETE … WHERE column IN (…)` split into statements |
| `purgeBatch(driver, { table, key, where, limit? })` | Deletes up to one batch of matching rows |
| `everyNthCall(n)` | A counter that is `true` on every `n`-th call |
| `bumpVersionRow(driver, table, key, column?)` | Atomic `column = column + 1` on a version row, created at `0` when absent |

## How it works

### Affected rows and duplicates

`rowsAffected()` returns `0` when the result has no numeric `RowsAffected`. A conditional write such as "revoke if not yet revoked" therefore reads an unknown count as "nothing happened", never as success.

`isUniqueViolation()` checks each error in the chain (up to 5 levels):

| Database | Signal |
| --- | --- |
| PostgreSQL | `code === '23505'` |
| MySQL | `code === 'ER_DUP_ENTRY'` or `errno === 1062` |
| MSSQL | `number === 2627` (constraint) or `2601` (unique index) |
| SQLite | message contains `UNIQUE constraint failed` (primary keys report the same text) |

A `ResourceDuplicated` alone is not enough: the SQLite driver throws it for every constraint failure on insert, `NOT NULL` and `CHECK` included.

### SQL fragments

In `` sql`…` `` a nested fragment is inlined with its bindings, an array becomes `?, ?, …`, and any other value becomes one `?`. An empty array throws `InvalidArgument`, because `IN ()` is not valid SQL. Identifiers are never quoted: pass them through `sql.raw()` or quote them with the driver's `IdentifierQuoter`.

`sql.and()` and `sql.or()` wrap each part in parentheses. One part is returned as is. No parts gives `sql.TRUE` (`1 = 1`) for `and` and `sql.FALSE` (`1 = 0`) for `or`. Neither uses boolean literals, which MSSQL lacks.

### Composite keys

Row-value `(a, b) IN ((?, ?), …)` is not portable. `whereInGroups()` adds one where group of the form `(groupColumn = ? AND column IN (…)) OR …`, one branch per map entry. Entries with no values are skipped. When nothing is left the group is `1 = 0`, so the query matches no rows.

### Batches

MSSQL accepts at most 2100 parameters per statement and 1000 rows per `VALUES` list. `insertChunked()` picks `min(1000, floor(2000 / columns))` rows per statement from the widest row, and `deleteChunked()` binds `IN_CHUNK` (1000) values per statement. Both run the statements in order and return the summed `rowsAffected()`.

`purgeBatch()` runs two statements:

1. It selects up to `limit` (default 500) values of `key` from the rows `where` matches, ordered by `key` (MSSQL needs an `ORDER BY` to page).
2. It deletes the rows with those keys that `where` still matches, so a row that changed in between stays.

Pair it with `everyNthCall()` to purge from a hot path now and then instead of on a timer.

### Version rows

`bumpVersionRow()` inserts `{ ...key, [column]: 0 }` with `orIgnore()`, then runs one `UPDATE … SET column = column + 1 WHERE …`. The increment is a single statement, so concurrent bumps never lose a count. Call it inside the caller's transaction when the bump must commit with the change it versions.

## Usage

```ts sample
import { OrmDriver, everyNthCall, insertChunked, isUniqueViolation, purgeBatch, rowsAffected, sql, toRawQuery, whereInGroups } from '@spinajs/orm';

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
    if (!isUniqueViolation(err)) throw err;
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
```
