---
"@spinajs/orm-history": minor
---

New package `@spinajs/orm-history`: `@History()` and `registerHistory()` declare full-row or column history per model and the audit trail it is recorded in; `audit.data.rules` turns tracking on by model name or for every model, with a schema for the `audit.data` section, and `@History(false)` opts a model out.

`HistoryObserver`: every write of a tracked model is recorded as a `data` event of its audit trail (default `history`, table `orm_history`) inside the write's own transaction, with the actor, the impersonator and the trace id of `AuditContext`; `audit.data.onUnknownKeys`; a `lost` marker when an insert does not report its keys. The package migrates `orm_history` on the default connection (`OrmHistory_2026_11_16_00_00_00`, a subclass of `AuditTrailTableMigration` of `@spinajs/audit-orm`); for tracked models on another connection the application binds a subclass of it to that connection. A tracked write whose record cannot be written fails and is rolled back.
