# Database

The upload keeps its state in three tables on the connection alias `upload`: sessions, parts and blobs. The package ships the migration and three read models; every write is a conditional statement in `UploadStore`.

## How it works

1. The package config sets `db.Aliases.upload: 'default'`, so the tables live on your default connection. Point the alias elsewhere in your own config.
2. `Upload_2026_10_23_00_00_00` is decorated `@Migration('upload')` and exported from `@spinajs/upload`, so importing the package registers it. The package sets no `system.dirs.migrations` and leaves yours alone.
3. Run it like any migration: `Migration: { OnStartup: true }` on the connection the alias names, or `npx spinajs migrate-up`, a command that comes from `@spinajs/orm-cli`, which you install.
4. `UploadSession`, `UploadPart` and `UploadBlob` are `@Connection('upload')` models. Importing the package registers them, so with `db.StrictTableCheck` on (the default) the tables must exist on that connection.
5. State changes never go through a model save. `UploadStore` runs one conditional `UPDATE` per transition whose `WHERE` is the transition rule; the matched-row count says whether it applied.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `db.Aliases.upload` | `string` | `'default'` | a connection `Name`, or `default` | Connection of the upload tables, models and migration. |

```ts
// config/db.ts in your app: upload tables on their own database
export default {
  db: {
    Connections: [
      { Driver: 'orm-driver-postgres', Name: 'main', Host: 'db', Database: 'app', User: 'app', Password: process.env.DB_PASSWORD },
      { Driver: 'orm-driver-postgres', Name: 'files', Host: 'db', Database: 'files', User: 'files', Password: process.env.FILES_DB_PASSWORD, Migration: { OnStartup: true } },
    ],
    DefaultConnection: 'main',
    Aliases: { upload: 'files' },
  },
};
```

## Schema

### `upload_sessions`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `varchar(36)`, primary key | Session id, a UUID string. |
| `owner` | `varchar(255)`, null | Opaque owner from `ownerOf()`; null for an unowned session. |
| `name` | `varchar(255)` | Client file name. |
| `size` | `bigint` | Declared size in bytes. |
| `part_size` | `bigint` | Fixed at create; a part can be up to 5 GiB. |
| `part_count` | `int` | Fixed at create. |
| `declared_sha256` | `varchar(64)`, null | Hex SHA-256 from create or complete. |
| `declared_mime` | `varchar(255)`, null | MIME type of the name. |
| `detected_mime` | `varchar(255)`, null | MIME type of part 1's content; set at completion. |
| `status` | `varchar(16)` | `open`, `assembling`, `completed`, `failed`, `aborted`, `expired`. |
| `metadata` | `text` | JSON object; the model reads it with `@Json()`. |
| `temp_fs`, `files_fs` | `varchar(64)` | Provider names, fixed at create. |
| `file_key` | `varchar(1024)`, null | Key of the merged file on `files_fs`; read it only from a `completed` row. |
| `sha256` | `varchar(64)`, null | Hex SHA-256 of the merged file. |
| `claim_token` | `varchar(36)`, null | Token of the current assembly claim. |
| `claimed_at` | `datetime`, null | When the claim was taken. |
| `failure_code`, `failure_message` | `varchar(64)`, `varchar(1024)`, null | Why a session `failed`. |
| `created_at`, `updated_at`, `expires_at` | `datetime` | `updated_at` changes on every transition and part commit. |
| `completed_at`, `handled_at` | `datetime`, null | Completion, and the first successful run of the completion handlers. |
| `final_event` | `varchar(32)`, null | The final event the session owes: `UploadCompleted`, `UploadFailed`, `UploadAborted` or `UploadExpired`. |
| `final_event_at` | `datetime`, null | When that event was emitted. |

Indexes: `upload_sessions_status_expires (status, expires_at)`, `upload_sessions_owner_status (owner, status)`, `upload_sessions_final_event (final_event, final_event_at)`.

### `upload_parts`

| Column | Type | Meaning |
| --- | --- | --- |
| `session_id` | `varchar(36)`, primary key part, foreign key to `upload_sessions.id` (cascade delete) | Session. |
| `number` | `int`, primary key part | Part number. The composite key is what a resent part upserts on. |
| `size` | `bigint` | Stored bytes. |
| `sha256` | `varchar(64)` | Hex SHA-256 of the stored bytes. |
| `storage_key` | `varchar(1024)` | Key of the live part object on `temp_fs`. |
| `detected_mime` | `varchar(255)`, null | Part 1 only. |
| `received_at` | `datetime` | When the part was committed. |

### `upload_blobs`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `varchar(36)`, primary key | Blob id. |
| `session_id` | `varchar(36)`, foreign key to `upload_sessions.id` (cascade delete) | Session. |
| `fs` | `varchar(64)` | Provider name. |
| `key` | `varchar(1024)` | Object key. |
| `kind` | `varchar(8)` | `part` or `file`. |
| `state` | `varchar(16)` | `writing`, `live` or `garbage`; see [Blob tracking](03-integrity.md#blob-tracking). |
| `created_at`, `updated_at` | `datetime` | `updated_at` changes with every state change. |

Indexes: `upload_blobs_state_updated (state, updated_at)`, `upload_blobs_session (session_id)`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `UploadStore` | `UploadStore`, `@Singleton()` | `UploadStore` | none | Every statement on the three tables. Use it, or the models, read-only. |
| `UploadSession` model | `@Model('upload_sessions')`, `@Connection('upload')` | scopes `ofOwner(owner)`, `open()`, `expiredBefore(at)` | none | Query it read-only, e.g. `UploadSession.query().ofOwner(userId).open()`. |
| `UploadPart` model | `@Model('upload_parts')` | scope `ofSession(id)` | none | Read-only. |
| `UploadBlob` model | `@Model('upload_blobs')` | scopes `ofSession(id)`, `inState(state)`, `updatedBefore(at)` | none | Read-only. |

## Important behaviour

- **Never save the models.** A model `update()` writes every changed column; a status change must be the conditional `UPDATE` of `UploadStore`, or a concurrent request's change is overwritten.
- **Uuids are strings.** The id columns are `varchar(36)`, not the ORM's binary uuid type.
- **Times are UTC `datetime`s**, read as luxon `DateTime`s.
- **Deleting a session deletes its parts and blobs** (cascade), but not the objects: the sweeper removes objects first, then the row.
- **Row locks come from the conditional `UPDATE`.** A part commit and a complete claim both update the session row first, which serialises them on Postgres and MySQL. SQLite runs one write transaction at a time.
- **The owner cap retries once.** `create` counts the owner's open sessions and inserts in one transaction that locks those rows first. When the database aborts it on a lock conflict (MySQL errno 1213 or 1205, SQLSTATE `40001` or `40P01`), the store runs it once more. A caller's own transaction is never retried. A retry after a lock wait timeout (1205) can double the worst-case latency of `create`. The MySQL path is covered by stubbed tests only.

## Best practices

- Run the migration before the app serves: with `db.StrictTableCheck` on, missing upload tables stop the boot.
- Turn `Migration.OnStartup` on for the alias's connection in development, and run `migrate-up` in your deploy pipeline in production.

## Examples

### List a user's unfinished uploads

```ts sample
import { UploadSession } from '@spinajs/upload';

export async function unfinishedUploads(userId: string): Promise<{ id: string; name: string; expiresAt: string }[]> {
  const sessions = await UploadSession.query().ofOwner(userId).open().orderBy('created_at');
  return sessions.map((s) => ({ id: s.id, name: s.name, expiresAt: s.expires_at.toISO() ?? '' }));
}
```

## Related

- [Connections](../orm/01-connections.md): `db.Aliases`, `Migration.OnStartup`, `db.StrictTableCheck`.
- [Migrations](../orm/10-migrations.md): running and writing migrations.
- [Integrity](03-integrity.md): what the blob states mean.
