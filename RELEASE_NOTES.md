# Release notes — ORM unified dirty tracking

> Branch `feat/orm-unified-dirty-tracking`. Design:
> `docs/superpowers/specs/2026-08-25-orm-unified-dirty-tracking-design.md`.

## BREAKING CHANGES

### `@spinajs/orm` — one change-tracking mechanism

`ModelBase` no longer keeps a write-time dirty list. The snapshot taken at hydration and after
every write is the only state; everything is derived from it.

| Removed | Use instead |
|---|---|
| `IsDirty` setter (`model.IsDirty = false`) | Persist the model, or `takeSnapshot()` to re-baseline by hand. |
| `markDirty(prop)` | Nothing — `attach()` / `detach()` are visible to `changeSet()` directly. |
| `changedColumns()` | `changeSet().map((c) => c.Column)` |
| The constructor's `Proxy` | Nothing — `new Model()` returns the plain instance. |

Behaviour changes:

- `IsDirty` is `true` for a model that has never been in the database (`IsNew`), and `false`
  again when a write restores the original value. It is computed on every read.
- `IsNew` and `changeSet(): IModelChange[]` (`{ Column, OldValue, NewValue }`) are new.
- Model members and column names share one namespace (active-record); a column named like a
  `ModelBase` member shadows it. The diff accessor is `changeSet()` — not `changes` — because
  `changes` is a real column name in downstream schemas.
- `insert()`, `refresh()` and `archive()` take a fresh snapshot after their statement, so a
  following `update()` on the same instance writes only what changed since. `insert()` now awaits
  its statement internally.
- `SingleRelation.attach()` on a `RelationType.Query` relation no longer flags the owner dirty;
  there is no column such a flag could write.
- `Relation.update()` persists every member that is `IsDirty` (new, or changed since loaded).
- `SingleRelation.attach(obj)` / `detach()` now also write the owner's foreign-key column (the
  target's join-column value, or `null`), and `toSql()` writes `NULL` for a detached relation.
  Before, `detach()` + `update()` — and therefore `SingleRelation.remove()` — wrote the old key
  back and never cleared the reference. A relation whose `populate()` found no row still keeps
  the row's key, as before.
- Foreign keys are resolved from the relation's **join column** (`Relation.PrimaryKey`)
  everywhere a model is serialized — `toSql()` in both `ModelToSqlConverter`s, the diff,
  `attach()`, and the unit of work's pending keys (`IPendingForeignKey` gained `JoinColumn`
  — required, a compile break for external code constructing one). Previously the target's
  primary key was used even when `@BelongsTo` declared another column. A relation holding a
  target overrides a direct write of the raw foreign-key column. Three paths remain exceptions
  and still stamp the target's **primary key**: the plain-object payload path
  (`StandardObjectToSqlConverter`); `OneToOneRelationHydrator` and `DbPropertyHydrator`, where a
  model instance passed under a relation or foreign-key name is stamped as `PrimaryKeyValue`
  (`packages/orm/src/hydrators.ts:39,120`); and `StandardModelDehydrator`'s foreign-key fallback
  (`packages/orm/src/dehydrators.ts:38`). The write path and the diff still resolve the join
  column correctly, so the rows that reach the database are right — but the in-memory and
  dehydrated value can be the primary key until the next write-back.
- `ForwardBelongsTo(ref)` without an explicit `primaryKey` now defaults the join column from the
  **target** model's primary key, resolved lazily on first access; it previously defaulted from
  the **source** model's. No in-repo caller relies on that default, so nothing here changes —
  flagged because the decorator is a published export, and an external model whose source and
  target primary keys differ will now join on a different column.
- After every successful write the foreign-key columns are reconciled with their relations
  before the fresh snapshot is taken, so a model converges to clean. Static bulk
  `Model.insert()` now re-baselines (and reconciles) model instances too.
- `SqlTimeValueConverter` (`@spinajs/orm-sql`) implements the snapshot hooks, so a `time` column
  (`TimeSpan`) baselines by value instead of `UNCOPYABLE` — previously such a column was reported
  as changed on every diff, with no usable `OldValue`, and its model never converged to clean.

---

# Release notes — email / queue / templates reliability overhaul

> Branch `feat/email-queue-templates-reliability`. These notes cover breaking changes and
> new behavior for consumers of the published `@spinajs/*` packages.

## BREAKING CHANGES

### `@spinajs/email` — connection configuration keys renamed

| Old key | New key | Notes |
|---|---|---|
| `email.connections[].pass` | `email.connections[].password` | **No fallback is provided.** A config still using `pass` will authenticate with an undefined password and fail at SMTP `verify()` on startup. |
| `email.connections[].sender` | `email.connections[].service` | `sender` was never read by the DI layer (`@AutoinjectService` always resolved the `service` key), so working configs already use `service`. The interface and JSON schema now match reality. |

### `@spinajs/email` — API renames

- `EmailService.processDefferedEmails()` → `processDeferredEmails()` (typo fix).
- Default queue routing key fixed: `EmailSendJob` → `EmailSend`. Routing is by job class
  name; the old key never matched, so deferred emails fell through to the default
  connection. If your config copied the old routing entry, rename the key.

### `@spinajs/queue` — newly registered migrations

Migrations `Queue_2026_07_02` (adds `LastError`, `MaxAttempts`, `UpdatedAt`) and
`Queue_2026_07_10` (adds `Phase`, `Message`) are now exported and therefore actually
registered/executed by the ORM. Deployments that never ran them will get the new
`queue_jobs` columns on next migration run. The `Status` column default is preserved
across the MySQL `MODIFY COLUMN` path, and rows are also inserted with an explicit
status so tracking no longer depends on a DB default.

## New behavior

### Deferred email retry, dead-letter, and failure reporting (`@spinajs/email`)

- Deferred emails (`sendDeferred`) now retry: `RetryCount` is taken from the new
  `email.retry.count` config (default **3**) or a per-email `retryCount` override.
  Previously deferred emails were marked dead on the first failure.
- New queue event **`EmailSendFailed`** is emitted exactly once when a deferred email
  permanently fails (all retries exhausted), carrying recipients, subject, JobId,
  attempt/max, and the error message. Subscribe to it to alert on failed mail.
- The default (black-hole) connection config documents a dead-letter channel
  (`defaultQueueDeadLetterChannel: 'email-jobs-dlq'`); real transports honor it.
- A failed `EmailSent` notification emit can no longer fail a successful send (which
  previously could cause a duplicate email via job retry).

### SMTP transport hardening (`@spinajs/email-smtp-transport`)

- Text-only emails (no template) now work; previously they threw `IOFail`.
- `sendMail` is guarded by an in-process resilience pipeline: 30 s timeout + 2
  exponential-backoff retries by default, configurable per connection via
  `resilience: { retries, delay, timeout }`. Note: SMTP retries are inherently
  non-idempotent — a retry after an ambiguous failure may deliver a duplicate.
- Connection verification failures are logged and rethrown as `UnexpectedServerError`
  with the original error preserved as the inner cause.

### Queue core (`@spinajs/queue`)

- `QueueService.emit()` / `QueueJob.emit()` now return the generated `JobId`
  (previously always `undefined`).
- `deduplicate` (default `true`) is implemented: a redelivered job whose `JobModel`
  row is already terminal is skipped instead of re-executed.
- `JobModel.MaxAttempts` is populated at first receipt.
- New overridable hook `QueueJob.onFailed(err, ctx)` runs after each failed execution
  (`ctx.isFinal` marks the dead-lettering failure); hook errors are logged, never mask
  the original failure.

### Metrics (Perf facade → structured logs + Prometheus)

- `template.render` / `template.compile` spans with an `engine` label
  (`@spinajs/templates`).
- `email.send` spans and `email.sent` / `email.send.failed` counters labeled by
  connection (`@spinajs/email`).

### Templates (`@spinajs/templates`, `-pug`, `-handlebars`)

- Compile caching consolidated onto one mechanism honoring
  `templates.cache.mode: 'cache' | 'revalidate' | 'always'` (dev default `always`,
  prod default `cache`).
- Renderers no longer mutate the caller's model object during rendering.
- Render timing log entries report real durations (a timer-key bug made handlebars
  always report 0 ms).
