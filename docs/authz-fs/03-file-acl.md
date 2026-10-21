# File ACL

The file ACL stores who holds which relation on which path, in the ORM table `fs_acl`. `AuthzFsMiddleware` keeps it in step with what file actions do; [relation grants](04-relation-grants.md) turn the relations into permissions.

## How it works

1. A row `(fs, path, subject, relation)` gives `subject` the relation on `path` and everything under it. A row on a directory or on the root (`''`) covers its subtree; the nearest rows up the path chain count.
2. Subjects are subject keys in the format of `@spinajs/authz-rbac`: principals (`user:alice`), every principal of a type (`user:*`) and subject sets (`team:t1#team.member`).
3. After a successful action, `AuthzFsMiddleware.after` updates the rows as described in [Important behaviour](#important-behaviour).
4. `OrmFileAclStore` is the default [`FileAclStore`](07-acl-store.md).

## Schema

### `fs_acl`

Migration `AuthzFsAcl_2026_10_17_00_00_00`, run on `authz.fsAcl.connection`.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `string(36)`, primary key | Row id. |
| `fs` | `string(64)` | Filesystem name. |
| `path` | `string(512)` | Normalised path; `''` is the filesystem root. |
| `path_hash` | `string(64)` | SHA-256 hex of the normalised path. |
| `subject_key` | `string(200)` | Subject key of the principal, wildcard or subject set. |
| `relation` | `string(64)` | One of `authz.fsAcl.relations`. |
| `expires_at` | `dateTime`, null | A row stops counting at this time. |
| `granted_by` | `string(100)`, null | Principal key of whoever granted the row. |
| `created_at` | `dateTime` | Creation time. |

- Unique key `(fs, path_hash, subject_key, relation)` on every driver. The hash keeps the key under the index limits of MySQL and MSSQL for 512-character paths.
- Index `(fs, path_hash, relation)`.
- Index `(fs, path)`, from migration `AuthzFsAclPathIndex_2026_10_21_00_00_00` (run it on an existing database): the prefix reads of `deleteTree` and `moveTree` use it. `moveTree` still rewrites the moved rows one by one in a transaction, because `path_hash` is computed in Node.
- `fs`, `path`, `path_hash`, `subject_key` and `relation` are `exact()` columns: the driver's binary collation compares them byte for byte, so `Report.pdf` and `report.pdf` are two paths. Lookups compare `path` itself.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `FileAclStore` | `FileAclStore`, root singleton | `OrmFileAclStore` | Any `FileAclStore` subclass | `DI.register(MyStore).as(FileAclStore)`; see [ACL store](07-acl-store.md). |

## Important behaviour

- **Owner.** The owner is the principal of the `owner` row. With `stampOwner` on, a path an action created gets an `owner` row after a definite allow; the first writer wins and an overwrite or append keeps the rows. `SYSTEM`, `UNATTENDED`, `anonymous` and `link` principals own nothing.
- **Occupied paths.** A write destination counts as existing when it is a file, a directory, or has entries under it at any depth (`hasEntries`; S3 counts nested keys). A probe error refuses the action. Only a free path has its stale rows, at it and under it, cleared before the IO. This also clears a row granted on a path that did not exist yet.
- **`rm`.** `ctx.isDir`, and for anything but a directory `ctx.hasEntries`, are asked before the IO. A directory loses the rows at its path and under it; anything else loses only its own rows. On S3 every key is a file, so the rows of other keys under its prefix stay, as those keys do. A key whose prefix still holds keys (`d` beside `d/a.txt`) shares its ACL path with that prefix and keeps its rows.
- **`move` and `rename`.** Onto an occupied destination the source rows are dropped and the destination keeps its rows. Onto a free path the rows move there, across filesystems too: a directory's whole tree, anything else its own rows. A source key whose prefix holds keys leaves its rows in place, whatever the destination. A move from an `off` filesystem carries no rows; into an `off` filesystem the rows move.
- **`copy`, `upload`, `zip`, `unzip`.** Only the owner row of a created destination is written; rows are not copied.
- **`IZipResult.unlink()`** removes the archive with `rm` outside the zip action: it is checked as `fs:delete` (an owner grant lets the archive's creator remove it) and drops the archive's rows.
- A row update that fails after the IO is logged at `error` and rethrown; the IO stays done.
- Paths over 512 characters have no rows of their own; rows on their parents cover them. `rm`, `move` and `rename` of such a path update no rows. A move onto such a path drops the source rows, and a directory move drops the rows whose new path would exceed 512 characters.

## Best practices

- Grant rows on directories, not on every file: one row covers the subtree.
- Use `FsAcl` for application changes (it checks `fs:manage`) and `FileAclStore` only in system code.

## Related

- [Relation grants](04-relation-grants.md)
- [Managing ACL rows](05-managing-acl-rows.md)
- [ACL store](07-acl-store.md)
