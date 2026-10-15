# Changelog

## Unreleased

First release of the package, versioned in lockstep with the other workspace packages (the
workspace is at 2.0.553; the next `bump-all` release ships it).

### Added

- New package `@spinajs/scheduler`: cron / interval / one-off / manual schedules declared with `@Schedule` or in configuration, with time zones (deterministic DST handling) and jitter.
- Exactly one run per occurrence across replicas through atomic conditional updates on the app database, using database time; leases with heartbeat, expiry reaping and graceful shutdown bounded by `shutdownGrace`.
- Run tracking: runs, attempts, steps, progress roll-up, messages, log lines, checkpoints and results in six `__scheduler*` tables plus the journal position counter `__scheduler_journal_pos` (migration `Scheduler_2026_10_15_00_00_00`, connection `default`). All instants are BIGINT epoch milliseconds; JSON payloads are stored as text (LONGTEXT on MySQL), so no column needs DB-side JSON support.
- Live run and schedule subscriptions that work across replicas; schedule streams resume on any replica without losing events, and capped runs still deliver their latest progress per step (`synthetic: true`).
- `schedules[].task` can schedule a `@Task` method of `@spinajs/tasks` (optional peer) with full run tracking and `currentRunContext()`; its `__task_history` row is still written.
- Misfire (`skip`, `run-once`, `catch-up(n)`, bounded scans), overlap (`skip`, `queue`) and `runOn: 'all'` (local work, no automatic retries).
- Automatic retries with fixed or exponential backoff, `dead` runs, `NonRetryableError`, resume from completed steps and the last checkpoint; manual retries get a fresh attempt budget.
- Error groups by fingerprint with regressions, schedule health, auto-pause after N consecutive failures (shutdown, lease loss and cancel are neutral).
- `SchedulerService` (`DefaultSchedulerService`) and `scheduler:*` CLI commands (run with params, wait, follow over SSE or in-process, local; cancel; retry; retry failed; pause / hard pause / resume; errors; prune), `--json` output and shared exit codes / HTTP statuses from `src/contract.ts`.
- Emit mode onto `@spinajs/queue` with status mirroring, per-occurrence UUIDv5 job ids (per run for manual runs and retries), `emitTimeout` for jobs that never appear, cancel of emitted runs and a boot warning for jobs routed to a black hole.
- Seven queue events (fire-and-forget, routed to a black hole by default), six Prometheus metrics, and the builtin `scheduler-retention` schedule.
- `FakeClock` test helper and the parity table shared with `@spinajs/scheduler-http`.

### Related changes in other packages

- `@spinajs/tasks`: `getTaskDeclarations()`, `runTask(decl, self, args, { lock, rethrow })`, `TaskDeclaration` and `RunTaskOptions`; `@Task` delegates to `runTask`. A failing `TaskSuccess` / `TaskFailed` emit no longer turns a successful run into a failure, and task history records the real error message.
- `@spinajs/di`: `@PerInstanceCheck` caches every instance (the same options resolve to the same instance, concurrent creations are shared when their options are deep-equal, and every instance is disposed); `DI.dispose()` disposes cached services in reverse resolution order.
