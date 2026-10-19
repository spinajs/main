# `@spinajs/authz-fs`

Authorization for `@spinajs/fs` filesystems. `AuthzFsMiddleware`, an `FsMiddleware` of `@spinajs/fs`, checks the
caller's `fs:*` permissions on every path of every file action before the provider runs, and keeps a per-file ACL
(table `fs_acl`) in step with what the action did. ACL rows become permissions only through RBAC relation grants.

Importing the package registers, in the root container: `AuthzFsMiddleware` (order 100), the resource adapter for
the `fs:*` permissions and the ACL relations (`FsResourceAdapter`), `OrmFileAclStore` as the `FileAclStore`, the
`fs_acl` migration and the upload middleware (`AuthzUploadMiddleware`). `getFs(name)` is always the provider
itself: there is no wrapper.

`AuthzFsMiddleware` and `OrmFileAclStore` are root singletons (`@Injectable`, no `@NewInstance`): DI keeps one
instance, the fs core resolves the middleware chain on every top-level action and gets that instance back, and both
read their configuration on every call. The middleware registers by class (`@Injectable(FsMiddleware)`): `@spinajs/fs`
collects middlewares with `Array.ofType`, which skips one registered through a DI factory or instance. To use another ACL store, register it as `FileAclStore` in the root container
(`DI.register(MyStore).as(FileAclStore)`): the last registration wins.

```ts
authz: {
  fs: {
    uploads: { mode: 'enforce', stampOwner: true },
    archive: { mode: 'audit', list: 'each' },
  },
  fsAcl: { connection: 'default', relations: ['owner', 'editor', 'viewer'] },
}
```

## Configuration

`authz.fs.<name>`, where `<name>` is the fs provider name. A filesystem without an entry is off. Unknown keys fail
boot (`InvalidConfiguration`); in a Configuration no schema checked they throw `AuthzConfigError`, so a key of the
removed guard (`metadata`, `resolver`, `inherit`, `policies`, `operations`) never passes silently.

| Key | Default | Meaning |
|---|---|---|
| `mode` | none, required | `off`: no checks. `audit`: check, warn on a denial, go on. `enforce`: a denial or a conditional permit throws `AccessDenied` (403). |
| `domain` | `root` | The authz domain the checks run in. Another domain must exist (`authz.domains`); authz-fs never creates one. |
| `stampOwner` | `false` (absent = off) | A path an action creates gets an `owner` row for the first writer. |
| `list` | `dir` | `dir`: `list` needs `fs:list` on the directory. `each`: each entry also needs `fs:stat`; `enforce` drops the others, `audit` keeps them and warns. |
| `signedUrl.defaultTtlSeconds` | 900 | Lifetime of a signed URL when the caller asks none. |
| `signedUrl.maxTtlSeconds` | none | Cap on any signed URL lifetime. |

`authz.fsAcl`: `connection` (ORM connection of `OrmFileAclStore` and of its migration, default `'default'`, the schema
default and `FS_ACL_DEFAULT_CONNECTION`) and `relations` (the relations an ACL row may name, default
`['owner', 'editor', 'viewer']`; `owner` is always served).

The middleware reads the entry of each target's own filesystem: `copy(src, dst, dstFs)` checks `src` with the source
filesystem's mode and `dst` with `dstFs`'s.

## Permissions and refs

`fs:read` (implies `fs:stat`), `fs:stat`, `fs:list`, `fs:write` (implies `fs:stat`), `fs:delete`, `fs:share`,
`fs:manage` (change ACL rows), on the types `fs`, `dir` and `file`. A path is the ref
`{ type: 'file' | 'dir', id: '<fs>:<path>' }`, the root is `{ type: 'fs', id: '<fs>' }`; ancestors are the parent
directories, the fs and GLOBAL. Each check passes the path's row (`{ id, type, fs, path }`) as the subject, so
relation grants and `resource.*` conditions answer definitely.

What each method checks is the action table of `@spinajs/fs` (read, stat, list, write, delete, share per target).
Paths are normalised by the fs core; a written path longer than 512 characters is refused with `InvalidArgument`
before any check, since the ACL cannot hold it (such a path is still covered by rows on its parents). SYSTEM is never
checked. While an `AuthzService` runs, a missing Configuration is an `AuthzConfigError`: the middleware fails closed
instead of leaving every filesystem unchecked.

## File ACL

A row `(fs, path, subject, relation)` gives `subject` the relation on `path` and everything under it: a row on a
directory or on the root (`''`) covers its subtree. Subjects are principals (`user:alice`), every principal of a
type (`user:*`) or subject sets (`team:t1#team.member`), in authz-rbac's subject key format.

Table `fs_acl` (migration `AuthzFsAcl_2026_10_17_00_00_00`, on `authz.fsAcl.connection`): `id`, `fs`, `path`,
`path_hash` (sha256 hex of the normalised path), `subject_key`, `relation`, `expires_at`, `granted_by`, `created_at`.
The key columns compare byte for byte (the driver's binary collation), so `Report.pdf` and `report.pdf` are two
paths. One row per `(fs, path_hash, subject_key, relation)` (unique index on every driver; the hash keeps the key
within MySQL's 3072-byte limit); reads still compare `path` itself.

Grants turn relations into permissions:

```ts
authz.roles.user.grants: [
  { permission: 'fs:*',     relation: 'owner',  on: [{ type: 'fs', id: 'uploads' }] },
  { permission: 'fs:write', relation: 'editor', on: [{ type: 'fs', id: 'uploads' }] },
  { permission: 'fs:read',  relation: 'viewer', on: [{ type: 'fs', id: 'uploads' }] },
  { permission: 'fs:list',  relation: 'viewer', on: [{ type: 'fs', id: 'uploads' }] },
]
```

`FsResourceAdapter.relations()` serves one `FsAclRelation` per type and `authz.fsAcl` relation, so another
`RelationResolver` for one of them fails the boot. `FsAclRelation.holds` takes the principal's subject keys from the
domain's `RbacService.subjectKeysOf` (the principal, companions, type wildcards and live subject sets) and looks
for a live row at the path, a parent directory or the root. Under a role ceiling (a role switch) a set row counts
only through a membership whose role passes `ceiling.roles`, and nested sets do not count. Under `inherit`
delegation the relation is evaluated for the delegate. Without an `RbacService` in the domain the keys are the
principal and its type wildcard; the same holds for a domain whose AuthzService runs no `rbac` model, even when a
parent domain registers an `RbacService`. `system`, `unattended`, `anonymous` and `link` principals hold no relation.
Known limit: `holds` never sees a request's `fresh` flag, so the subject keys come through the RBAC model's
assignment cache and a set membership may lag by its TTL. Paths longer than the `path` column (512) have no rows of
their own; the rows on their parents cover them.

What the middleware does to the rows after a successful action:

- a write or creation destination counts as existing when it is a file, a directory, or has entries under it at any
  depth (the core `hasEntries` probe; S3 counts nested keys), whatever the target's kind. A probe error refuses the
  action. Only a truly free path has its stale rows (at it and under it) cleared before the IO, so what is created
  there does not inherit them; this also clears a row granted on a path that did not exist yet;
- a path the action created, with `stampOwner` and a definite allow: an `owner` row for the principal the decision
  ran for, unless the path got one meanwhile (first writer wins). An overwrite or append keeps the existing rows;
- `rm`: a directory loses the rows at its path and under it, anything else only its own rows. Whether the path is a
  directory is asked before the IO (`ctx.isDir`, as for `move`); on S3 a key is never a directory, so the rows of
  other keys under its prefix stay, as those keys do;
- `move`/`rename`: onto an existing path (by the occupied test above), the source rows go and the destination keeps
  its rows; onto a free path the rows move there, across filesystems too (a directory's whole tree, anything else its
  own rows);
- `copy`, `upload`, `zip`, `unzip`: only the owner row of a created destination; rows are not copied. `upload`'s
  options (`{ exclusive }`) reach the provider unchanged;
- `IZipResult.unlink()` removes the archive with `rm` outside the zip action, so it is checked as `fs:delete` on the
  archive (an owner grant lets the archive's creator remove it) and drops its rows; on a filesystem in `off` mode
  nothing is checked.

A row update that fails after the IO is logged at error and its error is rethrown (the IO stays done). For
`writeStream` the rows are written when the stream finishes; `'close'` waits for them (`fs.middlewareTimeoutMs`).

`FsAcl` changes rows as the current principal: `grant(fs, path, subject, relation, { expiresAt? })`,
`revoke(fs, path, subject, relation)` and `list(fs, path)`. Each always enforces `fs:manage`, whatever the
filesystem's mode (only SYSTEM is exempt), on both the `file:<fs>:<path>` and the `dir:<fs>:<path>` ref (`fs:<name>` at
the root), in the domain of `authz.fs.<fs>.domain` (`root` without an entry). An fs with no published provider is an
`AuthzConfigError`, as is a relation outside `authz.fsAcl.relations`. `fs:manage` lets the holder grant any configured
relation, `owner` included, so a policy that gives owners `fs:*` lets them re-delegate. System code that needs
unchecked writes uses `FileAclStore` directly.

## Signed URLs

`signedUrl(path, opts)` and `getSignedUrl(path, until)` check `fs:share`; the URL lives until the earliest of the
asked `until` (else now + `defaultTtlSeconds`), now + `maxTtlSeconds` and the permit's `validUntil`, counted from the
domain's AuthzClock. An `until` that is not a valid luxon `DateTime` is an `InvalidArgument`.

## Uploads

`AuthzUploadMiddleware` (a `FileUploadMiddleware` of `@spinajs/http`) checks `fs:write` on `file.BaseName` in the
filesystem the uploader copies to (`file.Provider`, else `IUploadOptions.fs`, else
`__file_upload_default_provider__`) before the copy: `enforce` answers 403 and the temp file is never copied. The
middleware checks the copy again, but the uploader turns that denial into a 500. Add it to `http.upload.middlewares`,
or to a route's `middlewares` after a transformer that renames the file. Keep the default upload filesystem `off`.

## `fromFsPath`

`fromFsPath(fsName, param)` is a resource extractor for authz-http's `@Access`: the `file` ref of the url parameter
`param`, normalised with the published provider's `BasePath` (`fs` ref for the root). An Express 5 wildcard array is
joined with `/`; a refused segment or path is an `InvalidArgument` (400). Use `subject: 'load'` in `@Access` so a
relation grant answers definitely, and the filesystem's `domain` when it is not `root`.

## Tests

`npm test` runs every suite; `test/behaviour.test.ts` runs the kit's B28 on fsNative, fsTemp and fsS3. The `s3`
suites need localstack at `AUTHZ_FS_S3_ENDPOINT` (default `http://localhost:4566`;
`docker run --rm -d -p 4566:4566 -e SERVICES=s3 localstack/localstack`): without it they are skipped with a message,
with `AUTHZ_FS_S3=required` they fail. The ORM store suite runs on SQLite, and on Postgres and MySQL with
`AUTHZ_FS_DB=postgres,mysql` and the orm packages' test containers.
