# Custom stores and sinks

Three ports take your own classes. Each is found by registration name: `@Injectable(AuditEventSink) class HttpAuditSink` registers as `'HttpAuditSink'`, and a trail names that string. The module that declares the class must be imported before the trail is used.

| Port | Named in | Called for |
| --- | --- | --- |
| `AuditEventSink` | `audit.trails.<name>.sink` | Every batch the shipper takes out of `audit_outbox`. |
| `AuditStore` | `audit.trails.<name>.store` | Every write to the trail, and for its reader. |
| `AuditReader` | `audit.trails.<name>.reader` (shipping trails), or returned by your store's `reader()` | Reads, `forget`, retention and `verify`. |

## An `AuditEventSink`

`deliver(batch)` must return only once the events are durable at the destination, and may be called again with events it already stored: after a crash between delivery and delete, after a delivery abandoned at `audit.ship.deliverTimeoutMs`, or after a failed run. Deduplicate on `event.id`. A throw keeps the batch buffered and fails the trail on that connection for this run.

```ts sample
import { AuditEventSink } from '@spinajs/audit';
import type { AuditBatch } from '@spinajs/audit';
import { Injectable } from '@spinajs/di';

// audit.trails.central = { store: 'OutboxAuditStore', sink: 'HttpAuditSink' }
@Injectable(AuditEventSink)
export class HttpAuditSink extends AuditEventSink {
  protected readonly url = process.env.AUDIT_URL ?? 'https://audit.example.com/v1/batches';

  async deliver(batch: AuditBatch): Promise<void> {
    const body = JSON.stringify({
      trail: batch.trail,
      source: batch.source,
      events: batch.events.map((e) => ({ ...e, at: e.at.toISOString() })),
    });
    // The service stores each event once by id and answers 2xx only after the whole batch is durable.
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.AUDIT_TOKEN ?? ''}` },
      body,
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`audit: ${this.url} answered ${response.status} for ${batch.events.length} event(s) of trail ${batch.trail}`);
  }
}
```

Keep the request timeout under `audit.ship.deliverTimeoutMs`: past it the shipper gives up on the delivery, keeps the rows and delivers them again on the next run.

## A write-only `AuditStore`

`append(write)` stores `write.events` for `write.trail`; a throw fails the write. A detached confirmed or a deferred write is retried as the trail's `retry` says and then handled by its `onFailure`; a transactional or a joined write is tried once, and a failed transactional write always throws into the caller. `reader()` returning `undefined` makes every read, `forget` and `verify` of the trail throw `AuditNotSupported`.

```ts sample
import { appendFile } from 'node:fs/promises';
import { AuditStore, canonicalJson } from '@spinajs/audit';
import type { AuditAppend, AuditReader } from '@spinajs/audit';
import { Injectable } from '@spinajs/di';

// audit.trails.files = { store: 'JsonLinesAuditStore' }
@Injectable(AuditStore)
export class JsonLinesAuditStore extends AuditStore {
  async append(write: AuditAppend): Promise<void> {
    const lines = write.events.map((e) => `${canonicalJson({ trail: write.trail.name, ...e })}\n`).join('');
    await appendFile(`audit-${write.trail.name}.jsonl`, lines, 'utf8');
  }

  reader(): Promise<AuditReader | undefined> {
    return Promise.resolve(undefined);
  }
}
```

Two optional members change how the service treats a store:

- `joinsTransaction = true`: the store writes into `write.transaction` and commits and rolls back with it. Without it a `transactional` write to the trail is refused.
- `joinsCaller(trail, connection)`: asked before a confirmed write; `true` appends in the caller's async context, once, without retries and without `audit.confirmTimeoutMs`, so the event commits or rolls back with a transaction the caller holds open. A store that answers `true` must leave that transaction usable when its append fails, must bound the append itself (the service puts no deadline on it), and must answer `true` only while the caller holds a transaction the append will use.

`write.connection` is the connection a confirmed or deferred write named; a store that keeps no connections ignores it.

## An `AuditReader`

`list(trail, filter)` answers one page (`filter.limit`, `filter.order` by `seq`, and the optional filters of [Reading the trail](02-reading-the-trail.md)). `redact(trail, subject, source?)` blanks the payloads of one subject, keeps every other field, and returns how many it blanked. `prune(trail, before, source?)` deletes events older than `before` and returns how many. `forget` iterates `redactEach(trail, subject, source?)`, an async generator that yields one `{ connection, redacted }` per connection that needs its own `erasure` record (`connection` undefined for the trail's); `forget` records each before it asks for the next. By default it calls `redact` once and the record goes to `source`. Override it when one erasure spans several stores that `verify` checks apart. `verify` is optional: a reader without it makes `verify()` throw `AuditNotSupported`.

```ts sample
import { AuditReader } from '@spinajs/audit';
import type { AuditFilter, AuditSubject, StoredAuditEvent, TrailConfig } from '@spinajs/audit';
import { Injectable } from '@spinajs/di';

type Wire = Omit<StoredAuditEvent, 'at'> & { at: string };

// audit.trails.central = { store: 'OutboxAuditStore', sink: 'HttpAuditSink', reader: 'HttpAuditReader' }
@Injectable(AuditReader)
export class HttpAuditReader extends AuditReader {
  protected readonly base = 'https://audit.example.com/v1/trails';

  async list(trail: TrailConfig, filter: AuditFilter): Promise<readonly StoredAuditEvent[]> {
    const rows: Wire[] = await this.call(`${trail.name}/query`, filter);
    return rows.map((r) => ({ ...r, at: new Date(r.at) }));
  }

  async redact(trail: TrailConfig, subject: AuditSubject, source?: string): Promise<number> {
    const { redacted }: { redacted: number } = await this.call(`${trail.name}/redact`, { subject, source });
    return redacted;
  }

  async prune(trail: TrailConfig, before: Date, source?: string): Promise<number> {
    const { deleted }: { deleted: number } = await this.call(`${trail.name}/prune`, { before: before.toISOString(), source });
    return deleted;
  }

  protected async call(path: string, body: unknown) {
    const response = await fetch(`${this.base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`audit: ${path} answered ${response.status}`);
    return response.json();
  }
}
```

A reader over a trail table gets `verify` by extending `TableAuditReader` (or `ArchiveAuditReader`) and overriding `driver(trail, source)` or `table(trail)`; `verifyTable(driver, table, options?)` runs the same check on a table you reach yourself (`options`: `pinned`, the trail's `retentionDays` for `earlyPrunes`, and `clockSkewMs`, default 5000).

```ts sample
import type { TrailConfig } from '@spinajs/audit';
import { AuditReader } from '@spinajs/audit';
import { TableAuditReader } from '@spinajs/audit-orm';
import { Injectable } from '@spinajs/di';

// The reader of a shipping trail whose own sink fills legacy_<table> on the trail's connection.
@Injectable(AuditReader)
export class LegacyAuditReader extends TableAuditReader {
  protected override table(trail: TrailConfig): string {
    return `legacy_${trail.table}`;
  }
}
```

## Limits

- A sink that does not deduplicate on `id` stores duplicates: delivery is at least once.
- A store without `joinsTransaction` cannot take transactional writes, and one without a reader cannot be read, erased, pruned or verified from the application.
- A `TableAuditReader` subclass whose `table(trail)` or `driver(trail, undefined)` is not the trail's table on the trail's connection is erased there only, not on every connection that holds the trail table. Table names are compared as exact strings: the trail table under another spelling (`public.audit_event`, another case) counts as another table, so keep `table(trail)` returning `trail.table` as written when you mean it. Retention still finds connections by `trail.table` and calls `prune(trail, before, source)` once for each that holds it; override `prune` if your table lives elsewhere.
- A custom reader's `redact` must keep `data_hash` and every sealed field, or the seals of a sealed trail fail after an erasure, and must leave erasure records (`kind: 'custom'`, `action: 'erasure'`, `ERASURE` and `isErasureRecord` in `@spinajs/audit`) alone.
