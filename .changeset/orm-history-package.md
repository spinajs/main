---
"@spinajs/orm-history": minor
---

New package `@spinajs/orm-history`: `@History()` and `registerHistory()` declare full-row or column history per model and the audit trail it is recorded in; `audit.data.rules` turns tracking on by model name or for every model, with a schema for the `audit.data` section, and `@History(false)` opts a model out. A tracked model needs a single-column primary key with a text (a string or an integer): a composite key, or a key `@Uuid()` stores as bytes, is refused with `HistoryConfigError` under `@History()` and left untracked with a warning under a rule.

`HistoryObserver`: every write of a tracked model is recorded as a `data` event of its audit trail (default `history`, table `orm_history`) inside the write's own transaction, with the actor, the impersonator and the trace id of `AuditContext`. An insert whose keys are not reported, or have no text, records a `lost` marker and warns once per model, or fails under `audit.data.onUnknownKeys: 'throw'`. A tracked write whose record cannot be written fails; outside a transaction of your own it is rolled back.

The package declares the migration of `orm_history` on the default connection (`OrmHistory_2026_11_16_00_00_00`, a subclass of `AuditTrailTableMigration`) and imports `@spinajs/audit-orm`, which declares `audit_event` there. Until `npx spinajs migrate-up` has applied both, an application with `db.MigrationCheck: 'fail'` (the default) does not boot: `Orm.resolve()` rejects with `PendingMigrationsException`, also with no model tracked. For tracked models on another connection the application binds a subclass of the migration to that connection.
