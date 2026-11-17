# `@spinajs/audit-orm`

The database side of `@spinajs/audit`:

- `TableAuditStore`: a trail in a table (`audit_event` by default), written inside the audited transaction or on the trail's connection. Each trail owns its table: a trail of a table store whose table another such trail uses is refused with `AuditConfigError` (on write, read and retention; the other trails keep working), whatever their connections, because a trail table can hold events on any connection. A trail you add needs its own `table`.
- `AuditTrailTableMigration`: creates a trail table; the package migrates `audit_event` on the default connection. For another table or connection, extend it, override `table()` and add `@Migration(connection)`.
- `TableAuditReader`, `pruneAudit()` and `@spinajs/audit-orm/scheduler` (`AuditRetentionTask`). Retention applies per trail, to the trail's own table; a trail or connection that fails is reported after the others were pruned.
- `Model.audit()` and `row.audit()`: the `default` trail unless named; when the model's connection is not the trail's, both are read and merged by time. They apply no authorization scoping: the application decides who may call them. A producer that writes events about rows names them with `auditSubjectType(model)` and `auditSubjectId(key)` (composite keys as their escaped parts joined with `:`, binary keys as hex), so these reads find them.
- `@spinajs/audit-orm/testing`: `TestDb`, one ORM over sqlite, PGlite and the Postgres and MySQL servers that answer, for suites that write to trail tables.

## Confirmed writes inside a transaction

Whether a confirmed event survives the rollback of a transaction open on the connection it is written to depends on the driver. On a pooled driver (Postgres, MySQL, MSSQL) it is written on a connection of its own and is kept when the caller's transaction rolls back. On a driver that serves one transaction at a time (sqlite, PGlite: `supportedFeatures().concurrentTransactions` is `false`) it joins the caller's open transaction, because written apart it would wait for that transaction to end: there it is **not** kept when the transaction rolls back. So on such a driver, record the audit of a refused or failed action after the transaction that is rolled back, not inside it. The same holds for events a producer records inside the transaction, such as a read audited by `@AuditReads`: they are lost with its rollback too, so on sqlite and PGlite "no row is disclosed without a record" does not hold for reads made inside a transaction that rolls back.

A joined write is tried once, without the trail's retries and without a deadline, inside a savepoint; joined writes of one transaction run one after another. When one fails, the caller's transaction stays usable, a `reject` trail throws `AuditWriteFailed` for the caller to decide, and a `continue` trail logs the loss. The caller must await `record` inside its transaction: a joined write left running may land after the transaction has ended.

A confirmed write that is not joined and cannot finish fails at `audit.confirmTimeoutMs` (default 10000 ms): `AuditWriteFailed` on a `reject` trail, a logged loss on a `continue` trail. That is the case for connections that share one PGlite instance (`Options.Shared`): they are not detected as one connection, so a confirmed write to one of them while another holds a transaction waits for it and fails at the deadline.

## Read auditing

`@AuditReads({ trail, mode, columns, onFailure })` on a model records who read it. `mode: 'row'` (default) writes one
`read` event per returned row, `mode: 'query'` one per statement with the row count and the filter columns (never
their values). `columns` limits auditing to selects that return one of them. The record is written, confirmed, before
the rows are returned; when it cannot be written after the trail's retries the select rejects with `AuditWriteFailed`,
unless the rule says `onFailure: 'continue'` (the default is `'reject'`). `registerAuditReads(Model, options)` declares
the same for a model of another package.

What it sees: every select through a query builder that carries a model, hydrated or `asRaw()`, streamed (one write
per batch, before the batch is yielded), and the columns of an audited model that a `populate()` (of any relation
type, or through a relation's accessor) or a `join()` brings into a select of another model. A rule applies to the
model's subclasses and to every model of its table on its connection. Column names match without regard to case, as
sqlite and MySQL resolve them; the ORM quotes every identifier, so Postgres only knows the declared spelling.

Each selected column belongs to the table its table alias names: the queried table, a populate path, a joined model.
What cannot be attributed is read as widely as it could reach: a column under an alias that names no model counts for
every audited table with a column of that name, and a raw or `CASE` select expression for every audited column of
every table in the query (of the connection, when the query has a join). An aggregate over an audited column (`min`,
`max`, `sum`, `avg`, `count(column)`) discloses it; `count(*)` and aggregates over other columns do not. Where no row
can be named (no primary key in the result, an aggregate, `groupBy`), a row-mode rule writes one event per statement
in the query-mode shape with `keyless: true`. A binary key is written as hex.

What it does not see:

- raw SQL (`driver.execute()`, a `RawQuery` statement or join) and `driver.select()` without a model;
- what a filter reveals without selecting the column: a `where`, a `whereIn` or `whereExists` sub-select, a join
  condition or an `ORDER BY` on an audited column (`where('Ssn', '111')` tells whether that value exists);
- data the application already holds: rows loaded before, kept in memory or in a cache, and handed out again.

`paginate()` over-records: the one row it fetches beyond the page, to know whether a next page exists, is recorded.

Row mode needs a primary key: declaring it on a model without one fails where the rule is declared. It writes one
event per row per select, so give a list endpoint `columns` or `mode: 'query'`.

A read inside a transaction: on a pooled driver (Postgres, MySQL) the record is written on another connection and
stays when the caller rolls back. On a single-connection driver (sqlite, PGlite) whose trail table is on that same
connection, the record joins the open transaction, also one the ORM opened itself (the reload of
`save({ reload: true })`, relations loaded there, authz-orm's update and delete checks). It is tried once, commits with
that transaction and rolls back with it: there a read inside a transaction that rolls back leaves no record. Every other
confirmed record has a deadline, `audit.confirmTimeoutMs` (10 s by default); past it a `reject` rule fails the select.
