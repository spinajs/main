# Coverage

A trail holds the changes of a tracked model. It cannot say what it does not hold: a row with no entry after an instant may be unchanged, or its changes were made before tracking began, deleted by retention, or written by an insert whose keys the database did not report. Coverage says from which instant on the trail holds every change of the columns an entity's registration records, so a reader can tell "no change" from "not recorded".

```ts sample
import { DI } from '@spinajs/di';
import { HistoryCoverage } from '@spinajs/orm-history';

/** True when "no entry of an invoice after `instant`" means "no invoice changed after `instant`". */
export async function completeSince(instant: Date): Promise<boolean> {
  const since = await DI.resolve(HistoryCoverage).since('history', 'default', 'invoice');
  return since !== undefined && since.getTime() <= instant.getTime();
}
```

`since(trail, connection, entity)` takes the trail's name, the connection the model is on (a configured name, an alias or `default`) and the entity: the table name, unless `@History({ entity })` names another. It answers `undefined` for an entity that was never covered or a connection without the table, rejects with `HistoryConfigError` for a connection the ORM does not have and with `AuditConfigError` for a trail this process has no configuration for.

Read the entries first, then `since()`: a retention run in between only moves the answer forward, so the range it claims is one the entries you read still held. In the other order a run that starts after `since()` has answered can delete the oldest entries of that range before you read them.

The claim is about the columns the registration records, never about the whole row. A column it excludes, masks or does not track (column mode, `@History({ columns })`) is never covered: an update that writes only such columns leaves no entry at all, inside the covered range too. Before a replay reads a column from the trail, check that the model's registration records it.

## What sets and moves it

| When | `since` becomes |
| --- | --- |
| The first boot of the application that tracks the entity | that boot |
| A later boot | unchanged |
| An insert whose keys are not reported, or a statement that reaches a key without a text (a [`lost` event](01-tracking-models.md#inserts-whose-keys-are-not-reported)) | the instant of that event, when the write commits |
| A boot whose registration records a column that was excluded, masked or not tracked before | that boot |
| A retention run over the trail (`pruneAudit`, the `audit.retention` task) | the run's cutoff, when it is later; moved before the older events are deleted |
| A trail with `retentionDays`, at every read | never earlier than `retentionDays` before the read, plus 5 seconds, also before the first retention run ([Retention](#retention)) |
| A column added to the table, a column the registration no longer records | unchanged |
| `@History(false)` / `registerHistory(Model, false)` | no coverage: the row is deleted at the next boot |

The stored instant only moves forward. The bound at read time follows the configuration: it moves back when `retentionDays` is raised or removed.

## Who records it

The application's boot does, once the ORM has loaded its models: one row per tracked table, written in the background. `since()` waits for a recording in flight, so a read right after the boot sees it. A boot by a migration tool (`npx spinajs migrate-up`) records nothing. An application that resolves its ORM in a child container calls `record()` once after the boot, and so does one whose only boot is the migration tool's (`resolveMigrationTool()`, `migrateTestDatabase()`): a desktop application that migrates when it starts, a test.

A package that registers a model after the ORM has booted records it itself, and so does a test that creates its tables after the boot:

```ts sample
import { DI } from '@spinajs/di';
import type { ModelBaseClass } from '@spinajs/orm';
import { HistoryCoverage, registerHistory } from '@spinajs/orm-history';

export async function trackLate(model: ModelBaseClass): Promise<void> {
  registerHistory(model, { trail: 'history' });
  await DI.resolve(HistoryCoverage).record([model]);
}
```

`record(models?)` records the tables of the given models, or of every loaded model. A table that cannot be recorded is named in a warning of the logger `orm-history` and has no coverage; the others are recorded.

## The table

Coverage is kept in `history_coverage`, on the connection of the tracked model: one row per trail, connection and entity, with the instant and the columns the entity's events hold. The package declares `OrmHistoryCoverage_2026_11_25_00_00_00` for the default connection. Every other connection that holds a tracked model needs a subclass, as for the trail table:

```ts sample
import { Migration } from '@spinajs/orm';
import { OrmHistoryCoverage_2026_11_25_00_00_00 } from '@spinajs/orm-history';

@Migration('reports')
export class ReportsHistoryCoverage_2026_11_25_00_00_00 extends OrmHistoryCoverage_2026_11_25_00_00_00 {}
```

On a connection without the table the tracked models have no coverage: `since()` answers `undefined`, a boot warns once, and tracked writes are not affected.

## Retention

A trail with `retentionDays` loses its older events to `pruneAudit()`. Before the events of a connection are deleted, the coverage of that trail on that connection moves up to the cutoff, so a row whose entries were pruned is never taken for an unchanged one. When the coverage cannot be moved, the events of that connection stay and the run reports it as failed (`AuditPruneFailed`). On a sealed trail retention removes whole sealed ranges, so events younger than the cutoff can remain for a while; coverage still starts at the cutoff. Calling a reader's `prune` yourself moves nothing.

The coverage is moved by the process that runs retention, and only when that process has imported `@spinajs/orm-history`: run retention in a process that loads the package. `since()` does not trust the row alone. For a trail with `retentionDays` it never answers earlier than that many days before the read, plus 5 seconds, also before the first retention run, so a worker that runs `AuditRetentionTask` without loading a tracked model, and leaves the row where it was, still gets no claim over the events it deleted. The bound is taken from the configuration and the clock of the process that reads, while the cutoff of a run is taken from the clock of the process that prunes; the 5 seconds cover a pruning clock that runs up to that much ahead. The bound does not help in three cases, where `since()` can answer an instant whose events are gone:

- **Configuration.** `retentionDays` was raised or removed after a run by a process that has not loaded `@spinajs/orm-history`, or the reading process is configured with a longer one than the process that pruned, or with none.
- **Clocks.** The clock of a process that has not loaded `@spinajs/orm-history` ran more than 5 seconds ahead of the reader's when it pruned. For a while after that run, `since()` can be too early by the excess. The same holds for `pruneAudit({ now })` called with a `now` more than 5 seconds later than the clock of the process that reads.
- **A direct prune.** A reader's `prune` was called directly with a cutoff later than `retentionDays` allows. It tells no listener, wherever it runs.

The first two cannot happen when retention runs in a process that loads `@spinajs/orm-history`: the run moves the row to its own cutoff. Otherwise keep the clocks of the processes that prune and that read within 5 seconds of each other.

## What is not covered

- **A table written by a tracked and an untracked model.** Two model classes can map onto one table. When they are not all tracked in the same trail under the same entity, writes through one of them are missing from the stream, so the table has no coverage and a boot warns once. Track every model of the table the same way.
- **Tracking that was removed without an opt-out.** Deleting `@History()` from a model, or its `audit.data.rules` entry, leaves the row, which keeps saying "complete" while nothing is recorded any more. End tracking with `@History(false)` for one release: the next boot deletes the row. An opt-out deletes the row of the table's name; a model tracked under another `entity` keeps its row until it is deleted by hand. Tracking that is added again later continues the row that was left: the time without tracking is then inside the covered range for good.
- **A model moved to another trail, `entity` or connection.** The boot writes a row under the new key and leaves the old one, which keeps saying "complete" for a trail that gets no more of the table's events; moved back, the model continues the old row. Opt out for one release before the move, or delete the old row from `history_coverage`.
- **Two tables tracked under one `entity` in one trail** share one row, so the table tracked later takes the instant of the first.
- **Another process that writes the table untracked.** Coverage is what the tracking processes record. A worker that loads the model without the registration writes rows the trail never sees, while the row says "complete".
- **A rolling deploy.** The first node of a release that introduces tracking (a new `@History()`, or the removal of `@History(false)`) writes the row at its boot, while nodes of the old version keep writing the table untracked until they stop; a release that starts recording a column has the same window for that column. Deploy such a release without overlap, or delete the row from `history_coverage` once the last old node has stopped: the next boot writes it again.
- **Writes the capture does not see** ([Limits](04-limits.md#what-is-not-recorded)): raw SQL, builders without a model, cascades and triggers.
- **A data migration.** A migration that rewrites a covered table with a builder or raw SQL runs after the row exists, so its writes are inside the covered range for good, and no call restarts coverage. Delete the row from `history_coverage` in the same migration; the next boot of the application writes it again.
- **Clocks.** Every instant is the clock of the process that stamps it, never the database's: the row takes the clock of the booting process, a `lost` marker the clock of its writer, before its transaction commits, the retention bound the clock of the reader and a retention cutoff the clock of the pruner. A writer whose clock lags, or a transaction that commits late, makes coverage start before the lost write was visible. Keep the clocks of every node synchronised, and keep a margin when replaying near the start of coverage.
- **Retention, in three cases** ([Retention](#retention)): `retentionDays` raised or removed after a run by a process that has not loaded `@spinajs/orm-history`; such a run by a process whose clock runs more than 5 seconds ahead of the reader's; and a reader's `prune` called directly. In each, `since()` can claim a range whose events are gone.
- **A renamed column** reads as a new one: it restarts nothing, and the entries before the rename hold the old name.
- **A shipping trail** (`OutboxAuditStore`): an event reaches the archive some time after its write, so `since` can be earlier than what the archive already holds, and a `lost` marker counts only once it is archived.
- `asOf` does not read coverage; it keeps its own rule ([As-of and erasure](03-as-of-and-erasure.md)).
