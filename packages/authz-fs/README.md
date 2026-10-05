# `@spinajs/authz-fs`

Authorization checks for `@spinajs/fs` filesystems. Each filesystem named in `authz.fs` is wrapped in a guard
that checks the caller's `fs:*` permissions on every path before the provider runs. Tested on fsNative, fsTemp
over fsNative and fsS3 (localstack).

Import the package before `fsService` resolves. It registers, in the root container, the `FsDecorator` that
wraps the providers (`AuthzFsDecorator`), the resource adapter for the `fs:*` permissions
(`FsResourceAdapter`), the contributor that declares the permissions each filesystem checks
(`FsAuthzContributor`) and the upload middleware (`AuthzUploadMiddleware`).

```ts
authz: {
  fs: {
    uploads: { mode: 'enforce' },
    archive: { mode: 'audit', list: 'each' },
  },
}
```

## Configuration

`authz.fs.<name>`, where `<name>` is the fs provider name. A filesystem without an entry is off: `getFs(name)`
returns the raw provider. An entry must state a valid `mode`, and an unknown key is an `AuthzConfigError`, so a
typo never turns a guard off silently.

| Key | Default | Meaning |
|---|---|---|
| `mode` | none, required | `off`: the raw provider. `audit`: check, warn on a denial, go on (the engine records the denial when `authz.audit.denials` is on). `enforce`: a denial throws `AccessDenied`. |
| `domain` | `root` | The authz domain the checks run in (see "Domain and fs-inherit"). |
| `operations` | none | Method → permission or list of permissions, checked on argument 0. Adds a method, or replaces one that checks a single path (it keeps its `file`/`dir` kind). |
| `list` | `dir` | `dir`: `list` needs `fs:list` on the directory. `each`: each entry also needs `fs:stat`; `enforce` drops the others, `audit` keeps them and warns. |
| `signedUrl.defaultTtlSeconds` | 900 | Lifetime of a signed URL when the caller asks none. |
| `signedUrl.maxTtlSeconds` | none | Cap on any signed URL lifetime. |
| `metadata` | none | Class name of the `FileMetadataStore` that holds owners. |
| `stampOwner` | `false` | Record the first writer as the owner; needs `metadata`. |
| `resolver` | every `FsPathResolver` whose `fs` matches | Class name of the resolver that gives a path its domain parents (fs-inherit). |
| `inherit` | none | `fs:<op>` → action on the domain parent (fs-inherit). Not on a filesystem checked in `root`. |
| `policies` | none | ABAC policies of the filesystem (fs-abac). Not on a filesystem checked in `root`. |

Other keys: `authz.fsMetadata.connection` (ORM connection of `OrmFileMetadataStore`, default `default`) and
`authz.domains.<domain>.parent` (parent of a domain the package creates, default `root`).

Every permission the effective operation table of a filesystem names (its `operations` and `inherit` keys
included) is declared to the boot of its domain, so an unregistered one fails that boot.

## Permissions and refs

`fs:read`, `fs:stat`, `fs:list`, `fs:write`, `fs:delete` and `fs:share`, on the types `fs`, `dir` and `file`.
`fs:read` and `fs:write` imply `fs:stat`.

A path is the ref `{ type: 'file' | 'dir', id: '<fs name>:<normalised path>' }`; the root of a filesystem is
`{ type: 'fs', id: <fs name> }`. Its ancestors are the parent directories, nearest first, then the filesystem,
then GLOBAL, so a grant on `{ type: 'dir', id: 'uploads:users/alice' }` covers everything below it. Domain
parents from a resolver are not ancestors; fs-inherit reads them.

## Operations

| Method | Checks |
|---|---|
| `read`, `readStream`, `download`, `hash`, `metadata` | `fs:read` on the file |
| `exists`, `stat` | `fs:stat` on the file |
| `isDir`, `dirExists` | `fs:stat` on the directory |
| `list(dir)` | `fs:list` on the directory (and `fs:stat` per entry with `list: 'each'`) |
| `write`, `writeStream`, `append` | `fs:write` on the file |
| `mkdir` | `fs:write` on the directory |
| `upload(src, dest?)` | `fs:write` on `dest`, else on the basename of `src` |
| `rm` | `fs:delete` |
| `copy(src, dest, dstFs?)` | `fs:read` on `src`; `fs:write` on `dest` in `dstFs`, else here |
| `move(src, dest, dstFs?)` | `fs:read` and `fs:delete` on `src`; `fs:write` on `dest` in `dstFs`, else here |
| `rename(src, dest)` | `fs:read` and `fs:delete` on `src`; `fs:write` on `dest` |
| `zip(srcs, dstFs?, dstFile?)` | `fs:read` on each source; `fs:write` on the archive |
| `unzip(src, dest?, dstFs?)` | `fs:read` on `src`; `fs:write` on the destination directory |
| `signedUrl`, `getSignedUrl` | `fs:share` on the file |

Never checked: `resolvePath`, `tmppath`, `tmpname`, properties, symbols, `Object.prototype` members and the DI
lifecycle (`resolve`, `dispose`, `__checkInstance__`); `operations` cannot map them. Replacing `copy`, `move`,
`rename`, `zip`, `unzip` or `upload` is refused too, since one check on argument 0 would drop the others. Any
other method throws `AuthzConfigError` in `enforce` unless the principal is SYSTEM, and warns in `audit`.

## Guard

- The checks run in the filesystem's domain, as the ALS principal, else UNATTENDED, which is denied with
  reason `unattended`.
- Every check passes the path's row `{ id, type, fs, path }` as the subject (what `FsResourceAdapter.load`
  gives), so relation grants (`owner`) and `resource.*` conditions are decided for that path. An answer that is
  not a plain permit (a residual is left) counts as a denial: `enforce` throws `AccessDenied` (`needs_subject`),
  `audit` warns, `list: 'each'` drops the entry.
- `upload` does not check `src`: it is a local file outside every filesystem, so whoever may write may upload
  any file the process can read.
- `list` hands the provider the directory with a trailing `/`, so key stores do not match siblings by prefix.
- The guard is a Proxy: `instanceof`, `Name` and `Options.basePath` work as on the provider.

### Nested calls

Every path an operation touches, a destination on another filesystem included, is checked before the provider
runs. A destination filesystem is checked with its own entry (mode, domain); with mode `off` there it is not
checked. The provider then runs on the raw instance, and guarded calls it makes until the operation settles
(into `dstFs`, an fsTemp backend, a temp filesystem) are not checked again. Callbacks that run after the
operation settled (a `'data'` listener on a returned stream) are checked as usual.

`zip` and `unzip` without `dstFs` are checked where the provider writes: fsTemp writes into itself, fsNative
unzips into itself and zips into the published `fs-temp` (checked with that filesystem's entry). The guard names
a missing destination itself (`tmpname`), checks it and passes it. For other providers (S3, FTP) it checks only
the sources and refuses a named destination (`dstFile`, `dest`) without `dstFs`. The placement goes by
`instanceof fsNative` / `fsTemp`: a subclass that writes elsewhere is still checked where the base class writes.

The guard protects filesystems from principals, not from application code:

- properties pass through (`fsTemp.Provider`, `fsS3.S3`, `fsS3.TempFs` are raw), and app objects handed to an
  operation (a custom stream, a custom `dstFs`) run inside it, where nested guarded calls are not checked; an
  operation that never settles keeps that window open;
- internal temp filesystems (`fs-temp` behind fsNative zips, fsS3's temp filesystem) are reached unchecked
  inside an operation and checked as the principal outside one when they are guarded;
- an fsTemp with mode `off` over a guarded backend exposes the backend's storage, since fsTemp holds the raw
  backend (fsService wires providers before it decorates them).

## Paths

Every path a method gets is normalised before it is checked, and the guard passes the normalised path to the
provider, so the path checked is the path accessed.

`normalizeFsPath(path, basePath?)`:

- turns `\` into `/`, drops empty and `.` segments, applies `..`, and drops leading and trailing `/`;
  `''`, `.`, `./` and `/` are the root (`''`);
- makes an absolute path inside the provider's `Options.basePath` relative to it;
- reads any other path that starts with `/` or `\` and has no drive (`/x`) from the filesystem root
  (`x`), as `fsNative.resolvePath` does;
- refuses with `InvalidArgument`:
  - a path that climbs above the root (`../x`, `a/../../x`, `/..`);
  - a path with a NUL byte;
  - a drive path (`C:\x`, `C:x`) or UNC path (`\\host\share\x`) outside the base path;
  - a segment that holds `:` (a drive or an NTFS stream, `a.txt::$DATA`) or ends in `.` or a space
    (`secret.`, `secret `), which Windows treats as another name for the same file. This holds on S3
    and other key stores too: a key with `:` (an ISO timestamp such as `logs/2026-10-04T10:00.txt`)
    cannot be reached through a guarded filesystem.

Drive and UNC base paths are compared without regard to case, posix base paths exactly, always on whole
segments (`/data/up` is not inside `/data/upload`).

Normalisation keeps the case of the path. On case-insensitive filesystems (NTFS, default APFS) case
variants (`Secret/A.TXT`) and 8.3 short names (`SECRE~1`) reach one file under several ref ids. A grant
that names one form does not match the others, so grants fail closed, but deny rules (an ABAC deny policy
on `resource.id`, or a deny bound to a `dir` ref) do not: another form of the path skips them. Do not rely
on deny rules on fs paths there.

## Providers

The checks are the same on every provider; what the provider does with an allowed call is its own. On fsS3:

- `list` gives whole keys (`docs/a.txt`), fsNative gives names (`a.txt`);
- there are no directories: `isDir` is always `false`, `dirExists` always `true`, and `rm` or `move` of a
  "directory" touches one key, so directory rules (owners of a directory, `deleteTree`) do not apply;
- `resolvePath` of a relative path and `tmppath` throw `MethodNotImplemented` (the guard does not check them);
- `unzip` cannot extract onto S3: the destination must be a filesystem with local paths.

## Signed URLs

`signedUrl(path, opts?)` and `getSignedUrl(path, until?)` need `fs:share` on the file. The URL expires at the
earliest of:

- the asked `until`, or, when the caller asks none, now + `signedUrl.defaultTtlSeconds` (default 900, the S3
  signer's own default);
- now + `signedUrl.maxTtlSeconds`, when set;
- the `validUntil` of the `fs:share` decision (an expiring grant), when it has one.

So a URL nobody asked a lifetime for lives 900 s at most, whatever the caps or grants say. Now is the
`AuthzClock` of the filesystem's domain. The rule also holds in `audit`. An asked `until` that is not a valid
luxon `DateTime` is an `InvalidArgument`; the guard signs a copy of it, in its zone.

The S3 signer turns `until` into a lifetime with the wall clock (`diffNow`). With a custom `AuthzClock` that
runs ahead of the system time, S3 URLs live longer by that skew.

`getSignedUrl` is served through the provider's `signedUrl` when it has one; a provider with neither method
has nothing to call, as without the guard.

## Uploads

`AuthzUploadMiddleware` is a `FileUploadMiddleware` of `@spinajs/http`. Before the uploader copies a form
file, it checks `fs:write` on `file.BaseName` in the filesystem the uploader copies to (`file.Provider`, else
`IUploadOptions.fs`, else `__file_upload_default_provider__`), with that filesystem's mode and domain. `enforce`
answers 403 and the formidable temp file is removed, not copied; `audit` warns; `off` (or no entry) does
nothing. The guarded copy checks the destination again, but `ImmediateFileUploader` turns its denial into an
`IOFail` (500); the middleware gives the 403.

It is not in the defaults. `FromFile` runs `http.upload.middlewares` first, then the route's `middlewares`:

- without transformers, add it to `http.upload.middlewares` (config arrays are concatenated, so this follows
  http's own `FileInfoMiddleware`);
- on a route with a middleware that renames the file (`ZipFileTransformer`, `UnzipFileTransformer`), put it in
  that route's `middlewares`, after the transformer.

```ts
http: { upload: { middlewares: ['AuthzUploadMiddleware'] } },
authz: { fs: { uploads: { mode: 'enforce' }, '__file_upload_default_provider__': { mode: 'off' } } },
```

Keep the default upload filesystem `off`: the uploader reads and deletes the temp file there as the request
principal.

With a lazy uploader (`http-lazy-file-uploader`), the middleware checks the route's filesystem, not the
uploader's `fs`. The copy runs later in `LazyUploadJob` (`runAs: 'initiator'`), whose guarded `copy` checks the
destination as the principal that uploaded. authz-queue does not stamp a delegated, impersonated or
`onBehalfOf` principal: its lazy upload runs unattended and is denied by an enforced destination.

## `fromFsPath`

`fromFsPath(fsName, param)` is a resource extractor for authz-http's `@Access`. It reads the url parameter
`param` (only url parameters, as `fromParam`), normalises it as the guard does, with the base path of the
published provider, and gives `{ type: 'file', id: '<fs>:<path>' }`, or `{ type: 'fs', id: <fs> }` for the
root. An Express 5 wildcard (`*path`) gives the segments as an array: they are joined with `/`, and a segment
the normaliser refuses on its own (`..`, `.`, an empty one, one holding `/` or `\`) is refused. A missing
parameter, one that is neither a string nor a non-empty string array, or a refused path (`..` above the root)
is an `InvalidArgument` (400).

```ts
@Get('files/*path')
@Access('fs:read', { resource: fromFsPath('uploads', 'path'), domain: 'fs' })
public async download(@Param() path: string[]) {
  return getFs('uploads').read(path.join('/'));   // the path checked is the path read
}
```

The extractor carries no domain: for a filesystem whose `authz.fs.<name>.domain` is not `root`, set the same
`domain` in `@Access`, or the route is checked in root.

The ref is always a `file` (or the `fs` root): a grant on a `dir` ref covers it through its ancestors, but a
route that lists a directory checks a `file` ref with the directory's path, which a `dir` grant on that same
path does not match. The guard still checks the `dir` ref when the handler calls `list`.

## Owners and metadata

`metadata` names a `FileMetadataStore` by class name; the guard and the `owner` relation pick it among the
stores registered under `FileMetadataStore` (`AuthzConfigError` when none has that name). `stampOwner: true`
records who wrote a file:

```ts
authz: {
  fs: { uploads: { mode: 'enforce', metadata: 'OrmFileMetadataStore', stampOwner: true } },
  roles: { user: { grants: [
    { permission: 'fs:write', on: [{ type: 'fs', id: 'uploads' }] },
    { permission: 'fs:read', relation: 'owner', on: [{ type: 'fs', id: 'uploads' }] },
  ] } },
}
```

- Ownership goes to the first writer. `write`, `writeStream`, `append`, `mkdir`, `upload`, `copy` (destination),
  `zip` (the archive) and `unzip` (the destination directory) stamp a path only when they create it. A path that
  existed before keeps its metadata, also when it has none, so `fs:write` on a file or a directory gives no owner
  rights over it. A path that did not exist starts empty: before the IO, rows left there (by an `rm` outside the
  guard, or a failed update) are deleted: the row of the path, and the rows under it too when the provider reports
  no directory there either (a key store such as S3 reports every directory, so there only the row goes). After
  the IO the owner is stamped only if no owner appeared there meanwhile (the first stamp wins).
- First-writer works both ways: in a writable tree several principals share, whoever creates a path first (even an
  empty file, or a `writeStream` left open) owns what others later write there, and reads it through an owner
  grant. Where reads go by owner, grant `fs:write` on per-user prefixes
  (`{ type: 'dir', id: 'uploads:users/{principal.id}' }`) rather than on one shared directory. With an owner
  grant of `fs:delete`, the owner of a directory can `rm` it, files others wrote under it included, since `rm` is
  checked on the directory only.
- Only a definite allow stamps: an `audit`-mode denial or a conditional answer writes no owner. The owner is the
  principal the decision ran for: under `inherit` delegation the delegate, as the owner relation is then evaluated
  for the delegate too; under `intersect` the agent. SYSTEM, UNATTENDED, anonymous and `link` principals own
  nothing (anonymous callers and the bearers of a link share one id).
- `writeStream` stamps when the stream closes after it finished, and holds the `'close'` event back until then, at
  most `metadataTimeoutMs` (30 s); a stream that failed or was destroyed stamps nothing.
- `rm` deletes the metadata of the path, and of everything under it when the provider reports a directory. `move`
  and `rename` probe the destination like a write: onto an existing path, the destination keeps its metadata and
  only the source rows are deleted. Otherwise the metadata moves: with one store on both sides the whole tree, also
  between filesystems; between two stores only the row of the moved path, and the files under a moved directory
  lose their owners (a warning is logged). To a filesystem without a store the metadata is dropped. This happens
  with or without `stampOwner` once a store is configured. Unchecked calls a provider makes inside an operation
  keep no metadata.
- The store checks what it can before the IO (`checkMeta`: column sizes, the S3 limit), so a value it cannot hold
  stops the operation. A metadata update that fails after the IO is logged at error and its error rethrown (for
  `writeStream`: emitted to the stream's `'error'` listeners if it has any), since a lost owner row denies the
  owner later. The read before the IO and the write after it are not one transaction.
- The files `unzip`, `copy` or `upload` put under a directory get no owner of their own.

`FsResourceAdapter.relations()` serves `owner` on `file`, `dir` and `fs` (boot rule 8 asks for every type of the
permission). It holds when the store records the principal's `{ type, id }` for that path; it reads the store, never
the subject, and does not hold for the filesystem root or a filesystem without a store.

Stores:

- `OrmFileMetadataStore`: table `fs_object`, one row per filesystem and normalised path, on the connection
  `authz.fsMetadata.connection` names, else `default` (migration `AuthzFsObject_2026_10_01_00_00_00`). The key is
  not under `authz.fs`, which is keyed by filesystem name. `delete` removes one row; `deleteTree` and `move` take
  the rows under a directory path along (`LIKE ... ESCAPE '~'` with `%`, `_`, `~` and `[` escaped). Paths are
  matched exactly in code and rows changed by their stored key. The migration gives the key columns a binary
  collation on MySQL (`utf8mb4_bin`) and PostgreSQL (`"C"`); on a case-insensitive key (MSSQL, or a table created
  otherwise) a case variant of an existing path cannot be stored, and its update fails instead of sharing the
  row. Paths are limited to 512 characters; on MSSQL with nvarchar columns the `(fs, path)` key can exceed the
  900-byte index key limit, and an insert of a very long path then fails.
- `S3ObjectMetadataStore`: the metadata lives on the object as the user metadata `x-amz-meta-authz-meta`
  (URI-encoded JSON, within S3's 2 KB). It needs `getMetadata` and `setMetadata` (fsS3) on the provider and calls
  the raw provider behind the guard. `fsS3.setMetadata` copies the object onto itself: objects over 5 GB cannot be
  stamped, the copy drops the object's ACL and does not carry its storage class or SSE settings (an SSE-C object
  cannot be stamped), and a write between its HEAD and its copy can be lost. Whoever can PUT objects into the
  bucket directly (bucket credentials, a presigned PUT) can set any owner. A move between two S3 filesystems that
  share one store loses the owner, since the provider re-uploads the object.

## Domain and fs-inherit

For a filesystem whose `domain` is not `root`, `AuthzFsDecorator` (and, for a guard built by hand, the guard's
first call) runs `ensureFsDomain` once per domain. It creates the domain with `AuthzDomains.create(domain)` when
it is missing (its parent is `authz.domains.<domain>.parent`, else root). It then registers `FsInheritModel`
(`fs-inherit`) there when one of the domain's filesystems maps `inherit`, and `fs-abac` when one has `policies`.
Root never holds them.

```ts
authz: {
  fs: { uploads: { mode: 'enforce', domain: 'fs', resolver: 'TaskAttachmentPathResolver',
                   inherit: { 'fs:read': 'read', 'fs:write': 'update', 'fs:delete': 'update' } } },
  domains: { fs: { parent: 'root',
                   combine: { default: { algorithm: 'deny-overrides', models: ['rbac', 'abac', 'fs-abac', 'fs-inherit'] } } } },
}
```

- The decorator runs while `fsService` resolves, so the parent domain must exist by then; otherwise
  `fsService.resolve()` fails with `AuthzConfigError`.
- A child domain's `combine` replaces its parent's, `types` included, for every permission checked in it. That
  covers the `fs:*` checks and fs-inherit's parent checks (`task:read` above). List every model the parent
  domain routes for those permissions (`rbac`, `abac`, …) next to `fs-abac` and `fs-inherit`. A model left out
  is unrouted there: the host logs a warning at boot, and its deny rules do not apply in the fs domain. A
  `combine` that names `fs-inherit` without any `inherit` mapping fails boot rule 1, since the model is then not
  registered.
- `fs-inherit` permits `fs:<op>` on a file or directory when the principal holds `<parent type>:<action>` on a
  domain parent of the path (`FsPathResolver`, nearest parent first), where `inherit` maps `fs:<op>` to
  `<action>`. A permission also follows from the entries of those that imply it: with `'fs:read': 'read'`,
  `fs:stat` goes to `<type>:read` as well. Keys are `fs:` permissions and must be registered (they are boot
  refs); values are action names.
- The parent check runs in the same domain, as the principal the models run with (the delegate under `inherit`
  delegation), with the request's actor and env. Only an unconditional allow counts: the parent row is not
  loaded, so a parent permit with a condition gives nothing. `fs-inherit` never denies.
- Votes are cached like any other, while resolver answers carry no invalidation tag. A resolver must therefore
  answer from the path alone (`tasks/42/…` → task 42). One that reads a table (attachment row → task) can leave
  a decision in the cache for up to `cache.ttlSeconds` after the link changes.
- A parent permission that is not registered on the parent's type (`project:update` for a `project` parent), or
  a parent check that throws, makes the vote indeterminate (B04: denied under deny-overrides) unless another
  parent permits. Resolvers do not declare their parent types, so this is found per call, not at boot.
- Its summary lists every permission it may grant as conditional, so `covers` holds only for a holder that has
  them on every file.
- `fs-inherit` is not added to a domain that registers an `FsInheritModel` class of its own.
- Registering into a domain that already booted is an `AuthzConfigError`: resolve the fs providers before the
  domain's first `AuthzDomains.service()`. A boot that is still running when the providers resolve is not
  detected. With a `combine` that lists the fs models, that boot then fails rule 1. Without one, the domain runs
  without them, and the `fs-abac` deny policies do not apply.
- `inherit` or `policies` on a filesystem checked in root is an `AuthzConfigError` (decorator, and every domain
  boot): root never holds the fs models. Root-wide policies belong in `authz.abac.policies`.

## fs-abac

`authz.fs.<name>.policies` (the ABAC policy shape of `authz.abac.policies`) become one `AbacModel` named `fs-abac`
in the filesystem's domain. It runs over a `ConfigPolicyStore` of the policies of every filesystem checked there,
with a contributor, so a policy naming an unregistered permission fails the domain's boot. Boot errors name the
`authz.fs.<name>.policies` key of the policy.

```ts
authz: {
  fs: { uploads: { mode: 'enforce', domain: 'fs',
                   policies: [{ id: 'public', effect: 'permit', permissions: ['fs:read', 'fs:stat'],
                                when: { attr: 'resource.id', glob: 'uploads:public/**' } }] } },
  domains: { fs: { combine: { default: { algorithm: 'deny-overrides', models: ['rbac', 'abac', 'fs-abac', 'fs-inherit'] } } } },
}
```

- A filesystem's policies stay on that filesystem. A policy without a `scope` gets
  `{ type: 'fs', id: <name> }`, so a permit under `uploads` does not open `archive` in the same domain. Each
  policy is refused, with an `AuthzConfigError` naming the key and the policy id, when it has:
  - a `scope` other than that filesystem or a `dir`/`file` of it (a resolver parent such as a task is no
    ancestor of a path and would never match);
  - a permission or glob that does not start with `fs:` (it would also answer the domain's other checks, such
    as fs-inherit's `task:read`);
  - a resource type other than `fs`, `dir` or `file`.
- `resource.*` conditions read the path's row `{ id, type, fs, path }` that the guard passes as the subject.
- Policy ids must be unique within a domain: two filesystems with one id are an `AuthzConfigError` naming both.
- A domain the app created gets `fs-abac` too, once; as for `fs-inherit`, a domain that already booted is
  refused. A model of the app named `fs-abac` in that domain fails its boot (two models with one name).
- A deny policy beats permits of other models under `deny-overrides`.
- The model's summary lists each permitted permission. The entry is conditional when the policy has a condition
  or a scope, which every fs policy has.
- Importing `@spinajs/authz-fs` also loads `@spinajs/authz-abac`, which registers its `authz_policy` migration and
  its admin handlers, and `@spinajs/http`.
