# Integrity and verification

A trail with `integrity: 'sealed'` is made tamper evident: its events are hashed in `seq` order into chained seals in `audit_seal`, and `verify()` or `spinajs audit:verify` recomputes them.

## Setup

```json
{ "audit": { "trails": { "billing": { "table": "audit_billing", "integrity": "sealed" } }, "seal": { "settleSeconds": 30, "batchSize": 1000, "maxSeals": 100 } } }
```

Declare `AuditSealTableMigration` on every connection that holds a sealed table: each connection where the trail table exists, or, for a shipping trail, its archive connection. Import `@spinajs/audit-orm/scheduler` for `AuditSealTask`.

```ts sample
import { AuditSealTableMigration } from '@spinajs/audit-orm';
import { Migration } from '@spinajs/orm';

@Migration('default')
export class AuditSeal_2026_11_17_00_00_02 extends AuditSealTableMigration {}
```

Where a trail is sealed:

- a table trail: its table on every connection that holds it, each with its own chain;
- a trail with `archiveConnection`: its archive table, one chain across every source;
- a shipping trail without an archive in this application: nowhere here; the service that holds its archive seals it. A buffer is never sealed;
- a trail whose store keeps no table (`LogAuditStore`): refused, reported in `failed` and logged.

## What a seal covers

Each event enters a seal through `eventDigest`: SHA-256 over `id`, `at` as epoch milliseconds, `kind`, `action`, the subject type and id, `outcome`, `actor`, `onBehalfOf`, `traceId`, `origin`, `tenant`, `decisionId`, `idempotencyKey`, `dataSubject`, `source` (archives only; `null` elsewhere and for every absent field) and `data_hash`. `data_hash` is `payloadHash(data)`, the SHA-256 of the payload's canonical JSON (members sorted by UTF-16 code units, as RFC 8785), written on every row. `seq` enters through the order of the digests. A seal's hash is `sealHash(previous, digests)`: SHA-256 of the previous seal's hash and the digests, one per line. A seal covers the range `(previous to_seq, to_seq]` and records how many events it saw.

The payload enters only through its hash, so erasing a payload ([Erasure](08-erasure.md)) keeps the seal intact.

## The seal task

`AuditSealTask` (schedule `audit.seal`, every 60 seconds on the leader, timeout 10 minutes) runs `sealAudit()`. A seq is assigned at insert and visible at commit, so a transaction can commit a lower `seq` after a higher one was read; the sealer therefore seals only up to the head it noted at least `audit.seal.settleSeconds` (default 30) earlier, and notes the current head for a later run. An event is sealed within about two minutes; the heads are kept in the process, so a new leader waits one more run.

| Key | Default | Meaning |
| --- | --- | --- |
| `audit.seal.settleSeconds` | 30 | Must exceed the longest time an audited row sits between its insert and its commit. A row committed later lands in a range already sealed and is reported by every verification after. |
| `audit.seal.batchSize` | 1000 | Events per seal (at most 5000): the memory of one step and the resolution of a tamper report. |
| `audit.seal.maxSeals` | 100 | Seals per table and run; a backlog is sealed over several runs. |

Each seal is read and written in a transaction of its own; sealing inside a caller's open transaction is refused. Run one sealer: a second one sealing the same table at the same time is refused by the unique index on `(trail_table, from_seq)` and reported. A table whose `seq` was reset (re-created, or a MySQL 5.7 restart after retention emptied it) is reported and not sealed. After every seal the sealer logs the new head (`toSeq`, `hash`) at info level on the logger `audit-seal`.

## Verifying

```ts sample
import { audit } from '@spinajs/audit';

export async function checkBilling(loggedHead: { toSeq: number; hash: string }): Promise<boolean> {
  const report = await audit().trail('billing').verify(undefined, loggedHead);
  return report.tampered === undefined && report.unexplainedRedactions.length === 0 && report.uncovered.length === 0;
}
```

`verify(source?, pinned?)` walks the seal chain of the trail's table on `source` (default the trail's connection; for an archive, the archive connection, where `source` does not narrow the chain) and stops at the first seal or event that does not match. A table trail sealed on several connections is verified one connection per call.

| Report field | Meaning |
| --- | --- |
| `connection`, `table` | Where the chain was recomputed. |
| `seals` | Seals examined, the failing one included. |
| `intact` | Sealed events whose payload matches, in seals that match. |
| `redacted` | Sealed events whose payload was erased; their seal still matches. |
| `prunedSeals` | Seals whose events retention removed; only their link in the chain is checked. |
| `tampered` | The first mismatch, `{ seq, reason, fromSeq, toSeq }`; `undefined` when every seal matches. |
| `unsealed` | Events after the last seal. |
| `head` | The last seal that verified (`toSeq`, `hash`). |
| `uncovered` | Rows inside a sealed range that their seal does not cover: `late` (committed after its range was sealed, or inserted into it later; the two look the same) or `pruned` (written into a range retention removed). Their content is protected by no seal. |
| `unexplainedRedactions` | Seqs of erased payloads with no `erasure` event of their subject at or after them. |

| `tampered.reason` | Means | `seq` |
| --- | --- | --- |
| `payload` | An event's payload no longer matches its `data_hash`. | That event. |
| `seal` | A sealed field, a `data_hash` together with its payload, the order of events, or the seal's hash was changed. | First seq of the range. |
| `count` | A sealed event is gone, or more rows than a late commit explains are in the range. | First seq of the range. |
| `chain` | A seal is gone, replaced, or does not start where the previous one ended, or the pinned head was not met. | First seq of the range, or the pinned `toSeq`. |

Extra rows in a range are told apart from tampering by searching for the rows whose removal reproduces the seal's hash, within 2000 hash computations per seal: one late row in a seal is always found, two only in seals of about 60 events or fewer; more fall back to `count`.

A **pinned head** is a seal end and hash kept outside the database, for example the sealer's log line. The walk must meet a seal ending at its `toSeq` with that hash, else `chain`. It protects the chain up to that seal only: pin the latest logged head.

## `spinajs audit:verify`

```sh
npx spinajs audit:verify billing
npx spinajs audit:verify billing --source reporting
npx spinajs audit:verify shipped --head 18000:<64 hex digits from the sealer's log>
```

```
trail billing: table audit_billing on connection default
seals: 18 checked, 2 pruned
events: 15997 intact, 3 redacted, 41 not sealed yet
head: seq 18000, hash 9f2c…
result: intact
```

Further lines list rows not covered by their seal and redactions without an erasure record, at most 20 each. The result line is `result: intact`, `result: TAMPERED at seq <n> (<why>), seal <a>..<b>`, or `result: SUSPECT, <n> payload(s) blanked without an erasure record`.

| Outcome | Exit code |
| --- | --- |
| intact, also with rows listed as not covered by their seal | 0 |
| TAMPERED | 1 |
| SUSPECT | 1 |
| unknown trail, unreachable connection, invalid `--head`, a trail that is not sealed | 1, one line on stderr |

Exit code 0 does not mean nothing was inserted: read the "not covered by their seal" line.

## Retention

On a sealed trail retention removes whole sealed ranges: the events of every seal sealed before the cutoff, in chain order, and stamps those seals `pruned_at`; the seals stay, so the chain after them still verifies. Events not sealed yet are never pruned. The cutoff is compared with the seal's `sealed_at`, not with the events' `at`. Switching a trail from `sealed` to `none` and back lets plain retention delete rows inside sealed ranges, and the next verification reports `count`.

## Threat model

The chain is keyless. It detects an edit, deletion or reordering in a sealed range made by anyone **without** write access to `audit_seal`. It does not stop:

- **Anyone with the application's database credentials**, or SQL injection on its connection: they can rewrite the trail and `audit_seal` together. Only a head hash kept outside the database catches that, up to the pinned seal. Ship the sealer's head log line to an external, append-only log and pass it as `--head`; a write-once sink for the trail itself closes the rest.
- **An inserted row** in a sealed range: it is listed as `uncovered` `late`, exactly like a late commit, and the result stays intact.
- **A blanked payload with a forged erasure record**: a payload blanked with its `data_hash` kept looks exactly like a lawful erasure; only an `erasure` event of that subject tells them apart, and anyone who can write the table can write one too.
- **A forged prune**: `pruned_at` is trusted; a writer to `audit_seal` who marks a seal pruned and deletes its rows passes verification, a pinned head included.
- **The unsealed tail**, up to about two minutes, is not protected at all.

## Limits

- `settleSeconds` is an insert-to-commit limit: a transaction open longer than it leaves rows reported as `uncovered` in every later verification.
- The resolution of a tamper report is one seal (`batchSize` events), except for a payload edit, which names the event.
- `at` enters a seal as stored. Changing the time zone handling of a connection (the driver's or the server's) under sealed data makes the stored times read back differently, and every seal over them fails.
- A row written without `data_hash` (not by this package) is sealed with the hash of the payload it held; once erased it reads as tampered.
- Verification takes no snapshot: a retention run during it can produce a false `count`. Do not run it inside an open transaction on sqlite or PGlite.
