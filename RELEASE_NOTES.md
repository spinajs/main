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
