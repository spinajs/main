# File metadata stores

A `FileMetadataStore` keeps the metadata of a path: its owner, a scope and tags (`FileMeta`). The guard writes owners into it ([File owners](04-file-owners.md)) and the `owner` relation reads them. Two stores ship: `OrmFileMetadataStore` (a database table) and `S3ObjectMetadataStore` (the S3 object's own metadata). Name one per filesystem in `authz.fs.<name>.metadata`.

## How it works

1. Importing `@spinajs/authz-fs` registers `OrmFileMetadataStore` and `S3ObjectMetadataStore` under `FileMetadataStore` (`@Injectable(FileMetadataStore)`), and binds `FsObjectRecord` to the connection alias `authz-fs`.
2. The guard and `FsOwnerRelation` call `fileMetadataStore(fsName)`. It reads `authz.fs.<fsName>.metadata` and picks, by class name, one of the stores registered under `FileMetadataStore` (`Array.chainOf`, so factory registrations and parent containers count too). An unknown name throws `AuthzConfigError` that lists the registered stores.
3. The found store is cached per container and class name; the configuration is read on every call.
4. The guard calls `checkMeta(fs, path, meta)` before the IO when the store has it, then `get`, `set`, `move`, `delete` and `deleteTree` as the [owner effects](04-file-owners.md#how-it-works) need.

`FileMeta`:

| Field | Type | Meaning |
| --- | --- | --- |
| `owner` | `PrincipalRef` (`{ type, id }`) | Who owns the path. |
| `scope` | `ResourceRef` (`{ type, id? }`) | A scope the app records. The guard does not read it. |
| `tags` | `string[]` | Tags the app records. The guard does not read them. |

`checkFileMeta(meta)` returns a frozen copy holding only these fields, or throws `InvalidArgument`.

### `FileMetadataStore` contract

| Method | Contract |
| --- | --- |
| `get(fsName, path)` | The `FileMeta` of the path, or `null`. |
| `set(fsName, path, meta)` | Replace the metadata of the path. |
| `move(fromFs, from, toFs, to)` | Move the metadata of `from`, and of the paths under it, to `to`. |
| `delete(fsName, path)` | Delete the metadata of that path. |
| `checkMeta(fsName, path, meta)` | Optional. Throw for a value `set` could not store, without IO. |
| `deleteTree(fsName, path)` | Optional. Delete the path and every path under it; without it the guard calls `delete`. |
| `objectBound` | Optional. `true` when the metadata travels with the object (S3), so the guard overwrites a row it finds on a path the call created. |

## OrmFileMetadataStore

Keeps one row per filesystem and normalised path in the table `fs_object`, through the ORM model `FsObjectRecord`, on the connection alias `authz-fs`.

1. Every call awaits `ormReady()` (it resolves the `Orm` when nothing did yet) and takes the driver of `FsObjectRecord`. An alias that maps to no connection throws `AuthzConfigError` "no ORM connection answers to "authz-fs"; set db.Aliases['authz-fs']".
2. It normalises the path (`normalizeFsPath`) and checks the filesystem name.
3. `get` selects by `(fs, path)` and keeps only the row whose stored key equals the asked key, compared in code.
4. `set`, `move`, `delete` and `deleteTree` run in one transaction on that driver and change rows by the keys the rows hold.
5. Each row read back passes `checkFileMeta`. A row that fails it, or a `tags` value that is not JSON, throws `AuthzConfigError` naming `fs_object`.

```mermaid
sequenceDiagram
  participant G as fs guard
  participant S as OrmFileMetadataStore
  participant DB as authz-fs connection
  G->>S: checkMeta(fs, path, meta) before the IO
  G->>G: provider write runs
  G->>S: set(fs, path, { owner })
  S->>DB: BEGIN; SELECT fs_object WHERE fs, path
  S->>S: keep the exact match
  S->>DB: UPDATE by stored key, or INSERT
  S->>DB: COMMIT
```

| Method | Does |
| --- | --- |
| `get(fs, path)` | The path's `FileMeta`, or `null`. The filesystem root (`''`) answers `null`. |
| `set(fs, path, meta)` | Updates the row's columns and `updated_at`, or inserts a row with `created_at` and `updated_at`. The root is refused (`InvalidArgument`). |
| `checkMeta(fs, path, meta)` | The checks of `set` without IO. |
| `move(fromFs, from, toFs, to)` | Moves the row of `from` and every row under it; deletes the target rows first. |
| `delete(fs, path)` | Deletes the row of that path only. The root is a no-op. |
| `deleteTree(fs, path)` | Deletes the row of `path` and every row under it; `''` deletes every row of the filesystem. |

## S3ObjectMetadataStore

Keeps `FileMeta` in the user metadata of the S3 object itself, as `x-amz-meta-authz-meta` (`S3_FILE_META_KEY`, URI-encoded JSON). The metadata lives and dies with the object.

1. `S3ObjectMetadataStore` finds the published provider of the filesystem and takes the raw provider behind its guard, so its own reads are never checked.
2. The provider must have `getMetadata` and `setMetadata` (`fsS3` of `@spinajs/fs-s3` has both, `S3MetadataProvider`). Otherwise every call throws `AuthzConfigError`.
3. `get` reads the object's user metadata; a missing object or key answers `null`.
4. `set` merges the value into the object's other user metadata and calls `setMetadata`. It refuses a path that is not an object, and a total over S3's 2048 bytes of user metadata.
5. `move` copies the source's value to the destination and removes it from the source; when the source object is gone, the provider already moved the metadata with the object.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authz.fs.<name>.metadata` | `string` | none | class name of a registered `FileMetadataStore` | `'OrmFileMetadataStore'`, `'S3ObjectMetadataStore'`, or your own class. |
| `authz.fs.<name>.stampOwner` | `boolean` | `false` | `true`, `false` | Record the first writer as owner; needs `metadata`. |
| `db.Aliases['authz-fs']` | `string` | `'default'` | a connection name | The connection of `fs_object` and its migration. The package config sets the default; the app's value wins. |
| `db.StrictTableCheck` | `boolean` | `true` | `true`, `false` | The `Orm` boot fails until `fs_object` exists on the mapped connection. |
| `authz.fsMetadata.connection` | none | none | none | Removed. Setting it fails every domain boot with `AuthzConfigError` naming `db.Aliases['authz-fs']`. |

```ts sample
const config = {
  db: { Aliases: { 'authz-fs': 'files-db' } },
  authz: {
    fs: {
      uploads: { mode: 'enforce', metadata: 'OrmFileMetadataStore', stampOwner: true },
      media: { mode: 'enforce', metadata: 'S3ObjectMetadataStore', stampOwner: true },
    },
  },
};

export default config;
```

## Schema

### `fs_object`

Created by the migration `AuthzFsObject_2026_10_01_00_00_00` on `authz-fs`. Read and written through `FsObjectRecord` (`FS_OBJECT_TABLE`, fields `FsObjectFields`).

| Column | Type | Meaning |
| --- | --- | --- |
| `fs` | str(64), PK, `caseSensitive()` | Filesystem name. |
| `path` | str(512), PK, `caseSensitive()` | Normalised path. |
| `owner_type` | str(32), null | Owner principal type. |
| `owner_id` | str(64), null | Owner principal id. |
| `scope_type` | str(64), null | Scope type. |
| `scope_id` | str(64), null | Scope id; null with a type is the bare type. |
| `tags` | text, `@Json`, null | Tags as JSON; SQL `NULL` without tags. |
| `created_at` | datetime, `@DateTime` | Insert instant. |
| `updated_at` | datetime, `@DateTime` | Last write instant. |

`caseSensitive()` gives the key columns a binary collation, which keeps case variants apart. MSSQL cannot create the table yet.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| File metadata store | `FileMetadataStore`, every registration resolved as a list; the shipped ones registered at import (`@Injectable(FileMetadataStore)`) | none selected; `authz.fs.<name>.metadata` picks one by class name | `OrmFileMetadataStore`, `S3ObjectMetadataStore` | Register another class under `FileMetadataStore` before the first file call and name it in `authz.fs.<name>.metadata`. Subclass a shipped store to add checks. |

`OrmFileMetadataStore` takes no constructor arguments; its connection comes from `db.Aliases['authz-fs']`. `S3ObjectMetadataStore` takes `S3ObjectMetadataStoreOptions` (`container`, where the published providers are looked up; default the DI root). Related exports: `FS_METADATA_CONNECTION` (`'authz-fs'`), `checkRemovedFsMetadataKeys`, `FS_NO_OWNER_TYPES`.

### File metadata store: custom implementation

Write a store when owners must live elsewhere, such as an existing documents table. Implement the four abstract methods; add `checkMeta` when `set` can refuse a value, so the guard refuses before the IO.

```ts sample
import { DI } from '@spinajs/di';
import { FileMetadataStore, checkFileMeta, normalizeFsPath } from '@spinajs/authz-fs';
import type { FileMeta } from '@spinajs/authz-fs';

// Owners in memory: for tests and single-process tools.
export class MemoryFileMetadataStore extends FileMetadataStore {
  private readonly rows = new Map<string, FileMeta>();

  async get(fsName: string, path: string): Promise<FileMeta | null> {
    return this.rows.get(this.key(fsName, path)) ?? null;
  }

  async set(fsName: string, path: string, meta: FileMeta): Promise<void> {
    this.rows.set(this.key(fsName, path), checkFileMeta(meta));
  }

  async move(fromFs: string, from: string, toFs: string, to: string): Promise<void> {
    const src = normalizeFsPath(from);
    const dst = normalizeFsPath(to);
    for (const [key, meta] of [...this.rows]) {
      const [fs, path] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      if (fs !== fromFs || (path !== src && !path.startsWith(`${src}/`))) continue;
      this.rows.delete(key);
      this.rows.set(this.key(toFs, dst + path.slice(src.length)), meta);
    }
  }

  async delete(fsName: string, path: string): Promise<void> {
    this.rows.delete(this.key(fsName, path));
  }

  private key(fsName: string, path: string): string {
    return `${fsName}:${normalizeFsPath(path)}`;
  }
}

// Before the first file call; config: authz.fs.uploads.metadata: 'MemoryFileMetadataStore'
DI.register(MemoryFileMetadataStore).as(FileMetadataStore);
```

### OrmFileMetadataStore: add a check

Extend the shipped store to refuse metadata your app must not record. Call `super` so the column checks and the transaction stay.

```ts sample
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { FileMetadataStore, OrmFileMetadataStore } from '@spinajs/authz-fs';
import type { FileMeta } from '@spinajs/authz-fs';

// Only user principals may own files.
export class UserOwnedFileMetadataStore extends OrmFileMetadataStore {
  override checkMeta(fsName: string, path: string, meta: FileMeta): void {
    if (meta.owner && meta.owner.type !== 'user') throw new InvalidArgument(`${fsName}:${path}: only users own files`, 'owner');
    super.checkMeta(fsName, path, meta);
  }

  override async set(fsName: string, path: string, meta: FileMeta): Promise<void> {
    this.checkMeta(fsName, path, meta);
    await super.set(fsName, path, meta);
  }
}

// config: authz.fs.uploads.metadata: 'UserOwnedFileMetadataStore'
DI.register(UserOwnedFileMetadataStore).as(FileMetadataStore);
```

## Important behaviour

- **Exact keys (ORM).** Rows are matched in code and changed by their stored key, whatever the collation. MySQL's `utf8mb4_bin` and MSSQL ignore trailing blanks, so `uploads` and `uploads ` share one database key: storing the second is refused (the insert fails) instead of sharing the row. Paths never end in a blank; filesystem names may.
- **Tables created by hand (ORM).** On a case-insensitive key, a case variant of an existing key is refused the same way.
- **Limits (ORM).** `fs` 64, `path` 512, `owner_type` 32, `owner_id`, `scope_type` and `scope_id` 64 characters; a longer value throws `InvalidArgument` before any IO.
- **Moves (ORM).** A move of a directory into itself, or onto an ancestor that holds it, throws `InvalidArgument`.
- **Registered at import (ORM).** Importing `@spinajs/authz-fs` registers `FsObjectRecord` whether or not a filesystem uses the store. With `db.StrictTableCheck` on, the `Orm` boot fails until `fs_object` exists on the mapped connection.
- **Bucket writers (S3).** Whoever can PUT objects into the bucket directly (bucket credentials, a presigned PUT) can set any owner.
- **Copies (S3).** A same-bucket copy brings the source's metadata along; the guard then writes the new key to exactly the copier's metadata (`objectBound`).
- **Size (S3).** `checkMeta` counts only this value; the object's other user metadata also counts toward 2048 bytes, so `set` may still refuse after the IO.

## Best practices

- Apply the migrations before the first start (`spinajs migrate-up`, or `Migration.OnStartup`), so `fs_object` exists when the `Orm` boots ([Applying migrations](../orm-cli/01-applying-migrations.md)).
- Set `db.Aliases['authz-fs']` before the first migration run: the migration creates `fs_object` on the mapped connection. The alias is independent of `db.Aliases.authz` of [authz-orm](../authz-orm/03-authz-connection-and-records.md).
- Use `S3ObjectMetadataStore` only for buckets your app alone writes to.

## Patterns and antipatterns

```ts
// Don't: the removed key fails every domain boot
authz: { fsMetadata: { connection: 'files-db' } }

// Do: map the alias
db: { Aliases: { 'authz-fs': 'files-db' } }
```

## Migration

`authz.fsMetadata.connection`, `OrmFileMetadataStoreOptions` and `AUTHZ_FS_METADATA_CONFIGURATION_SCHEMA` are gone. The store takes no constructor arguments.

Before:

```ts
authz: {
  fsMetadata: { connection: 'files-db' },
  fs: { uploads: { mode: 'enforce', metadata: 'OrmFileMetadataStore' } },
}
```

After:

```ts
db: { Aliases: { 'authz-fs': 'files-db' } },
authz: {
  fs: { uploads: { mode: 'enforce', metadata: 'OrmFileMetadataStore' } },
}
```

Code that built the store by hand drops the options: `new OrmFileMetadataStore()`, or resolve it from DI under `FileMetadataStore`.

## Related

- [File owners](04-file-owners.md): when the guard stamps, moves and deletes metadata.
- [Object metadata](../fs-s3/03-object-metadata.md): `getMetadata` and `setMetadata` of `fsS3`.
- [Migrations](../orm/10-migrations.md): how `AuthzFsObject_2026_10_01_00_00_00` runs.
- [Tables](../authz/storage-and-check-flow.md#authz-fs): `fs_object` next to the other authz tables.
