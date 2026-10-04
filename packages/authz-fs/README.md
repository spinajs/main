# `@spinajs/authz-fs`

File system integration for SpinaJS authorization.

## Paths

Every path a filesystem method gets is normalised before it is checked, and the guard passes the
normalised path to the provider, so the path checked is the path accessed. Ref ids are
`<fs name>:<normalised path>` with the types `file` and `dir`; the root of a filesystem is
`{ type: 'fs', id: <fs name> }`.

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

## Guard

`AuthzFsDecorator` (an `FsDecorator` of `@spinajs/fs`, order 100) wraps every filesystem whose
`authz.fs.<name>` entry has mode `audit` or `enforce` in `guardFs`, a Proxy over the provider. A filesystem
without an entry, or with mode `off`, stays the raw provider.

- Each method of `FS_OPERATIONS` checks its path arguments in the domain `authz.fs.<name>.domain` (default
  `root`), as the ALS principal, before the provider runs. `enforce` throws `AccessDenied`; `audit` logs a
  warning and goes on.
- Every check passes the path's row `{ id, type, fs, path }` as the subject (what `FsResourceAdapter.load`
  gives), so relation grants (`owner`) and `resource.*` conditions are decided for that path. An answer that
  is not a plain permit (a residual is left) counts as a denial: `enforce` throws `AccessDenied`
  (`needs_subject`), `audit` warns, `list: 'each'` drops the entry.
- `authz.fs.<name>.operations` adds methods (checked on argument 0 as a file) or replaces a method that checks
  one path (it keeps its kind). Replacing `copy`, `move`, `rename`, `zip`, `unzip` or `upload`, or mapping
  `resolvePath`, `tmppath`, `tmpname` or a DI lifecycle method, is an `AuthzConfigError`.
- Any other method throws `AuthzConfigError` in `enforce` unless the principal is SYSTEM (`audit` warns).
  `resolvePath`, `tmppath`, `tmpname`, properties and DI lifecycle methods are never checked; `resolvePath`
  is not a boundary.
- A destination on another filesystem (`copy`, `move`, `zip`, `unzip` with `dstFs`) is checked with that
  filesystem's own entry; with mode `off` there it is not checked. Guarded calls a provider makes while an
  authorised operation runs (into `dstFs`, or an fsTemp backend) are not checked again.
- `zip` and `unzip` without `dstFs` are checked where the provider writes: fsTemp writes into itself, fsNative
  unzips into itself and zips into the published `fs-temp` (checked with that filesystem's entry). The guard
  names a missing destination itself (`tmpname`), checks it and passes it. For other providers (S3, FTP) it
  checks only the sources and refuses a named destination (`dstFile`, `destPath`) without `dstFs`.
- `list` hands the provider the directory with a trailing `/`, so key stores do not match siblings by prefix.
- `upload(srcPath, destPath?)` checks `fs:write` on `destPath`, or on the basename of `srcPath` when it is
  missing. `srcPath` is a local file and is not checked: whoever may write may upload any file the process
  can read.
- `list: 'each'` also drops the entries the principal lacks `fs:stat` on.

The guard protects filesystems from principals, not from application code:

- properties pass through (`fsTemp.Provider`, `fsS3.S3`, `fsS3.TempFs` are raw), and app objects handed to
  an operation (a custom stream, a custom `dstFs`) run inside it, where nested guarded calls are not checked;
  an operation that never settles keeps that window open;
- internal temp filesystems (`fs-temp` behind fsNative zips, fsS3's temp filesystem) are reached unchecked
  inside an operation and checked as the principal outside one when they are guarded;
- an fsTemp with mode `off` over a guarded backend exposes the backend's storage, since fsTemp holds the raw
  backend (fsService wires providers before it decorates them).
- `zip` and `unzip` destinations are placed by `instanceof fsNative` / `fsTemp`: a subclass that overrides them to
  write elsewhere is still checked where the base class writes.

## Owners and metadata

`authz.fs.<name>.metadata` names a `FileMetadataStore` by class name; the guard and the `owner` relation pick it among
the stores registered under `FileMetadataStore` (`AuthzConfigError` when none has that name). `stampOwner: true`
(which needs `metadata`) records who wrote a file:

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
  no directory there either (a key store such as S3 reports every directory, so there only the row goes). After the IO the owner is stamped only if no owner appeared there meanwhile (the first stamp wins), so a
  slow write does not take over what others created at that path while it ran.
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
- `rm` deletes the metadata of the path, and of everything under it when the provider reports a directory (a key
  store such as S3 has none, so removing a key leaves the other keys under that prefix alone). `move` and
  `rename` probe the destination like a write: onto an existing path, the destination keeps its metadata and only
  the source rows are deleted. Otherwise the metadata moves: with one store on both sides the whole tree, also
  between filesystems; between two stores only the row of the moved path, and the files under a moved directory
  lose their owners (a warning is logged). To a filesystem without a store the metadata is dropped. This happens with or without `stampOwner` once a store is configured. Unchecked
  calls a provider makes inside an operation keep no metadata.
- The store checks what it can before the IO (`checkMeta`: column sizes, the S3 limit), so a value it cannot hold
  stops the operation. A metadata update that fails after the IO is logged at error and its error rethrown (for
  `writeStream`: emitted to the stream's `'error'` listeners if it has any), since a lost owner row denies the
  owner later. The read before the IO and the write after it are not one transaction.
- The files `unzip`, `copy` or `upload` put under a directory get no owner of their own.

`FsResourceAdapter.relations()` serves `owner` on `file`, `dir` and `fs` (boot rule 8 asks for every type of the
permission). It holds when the store records the principal's `{ type, id }` for that path; it reads the store, never
the subject, and does not hold for the filesystem root or a filesystem without a store.

Stores:

- `OrmFileMetadataStore`: table `fs_object`, one row per filesystem and normalised path. The store and its migration
  `AuthzFsObject_2026_10_01_00_00_00` use the connection `authz.fsMetadata.connection` names (not under `authz.fs`,
  which is keyed by filesystem name), else `default`. `delete` removes one row; `deleteTree` and `move` take
  the rows under a directory path along (`LIKE ... ESCAPE '~'` with `%`, `_`, `~` and `[` escaped). Paths are matched exactly in code and rows changed by their stored key.
  The migration gives the key columns a binary collation on MySQL (`utf8mb4_bin`) and PostgreSQL (`"C"`); on a
  case-insensitive key (MSSQL, or a table created otherwise) a case variant of an existing path cannot be stored,
  and its update fails instead of sharing the row. Paths are limited to 512 characters; on MSSQL with nvarchar columns the
  `(fs, path)` key can exceed the 900-byte index key limit, and an insert of a very long path then fails.
- `S3ObjectMetadataStore`: the metadata lives on the object as the user metadata `x-amz-meta-authz-meta`
  (URI-encoded JSON, within S3's 2 KB). It needs `getMetadata` and `setMetadata` (fsS3) on the provider and calls
  the raw provider behind the guard. `fsS3.setMetadata` copies the object onto itself: objects over 5 GB cannot be
  stamped, the copy drops the object's ACL and does not carry its storage class or SSE settings (an SSE-C object
  cannot be stamped), and a write between its HEAD and its copy can be lost. Whoever can PUT objects into the
  bucket directly (bucket credentials, a presigned PUT) can set any owner. A move between two S3 filesystems that
  share one store loses the owner, since the provider re-uploads the object.

## Domain and fs-inherit

`authz.fs.<name>.domain` names the authz domain a filesystem is checked in (default `root`). For any other
domain, `AuthzFsDecorator` (and, for a guard built by hand, the guard's first call) runs `ensureFsDomain`:
it creates the domain with `AuthzDomains.create(domain)` when it is missing (its parent is
`authz.domains.<domain>.parent`, else root) and registers `FsInheritModel` (`fs-inherit`) in it, once per domain,
and `fs-abac` when one of its filesystems has `policies` (see below). Root never holds them.

```ts
authz: {
  fs: { uploads: { mode: 'enforce', domain: 'fs', resolver: 'TaskAttachmentPathResolver',
                   inherit: { 'fs:read': 'read', 'fs:write': 'update', 'fs:delete': 'update' } } },
  domains: { fs: { combine: { default: { algorithm: 'deny-overrides', models: ['rbac', 'fs-inherit'] } } } },
}
```

- `fs-inherit` permits `fs:<op>` on a file or directory when the principal holds `<parent type>:<action>` on a
  domain parent of the path (`FsPathResolver`, `authz.fs.<name>.resolver`, nearest parent first), where `inherit`
  maps `fs:<op>` to `<action>`. A permission also follows from the entries of those that imply it: with
  `'fs:read': 'read'`, `fs:stat` goes to `<type>:read` as well. Keys are `fs:` permissions and must be
  registered (they are boot refs); values are action names.
- The parent check runs in the same domain, as the principal the models run with (the delegate under `inherit`
  delegation), with the request's actor and env. Only an unconditional allow counts: the parent row is not
  loaded, so a parent permit with a condition gives nothing. `fs-inherit` never denies.
- A parent permission that is not registered on the parent's type (`project:update` for a `project` parent), or
  a parent check that throws, makes the vote indeterminate (B04: denied under deny-overrides) unless another
  parent permits. Resolvers do not declare their parent types, so this is found per call, not at boot.
- Its summary lists every permission it may grant as conditional, so `covers` holds only for a holder that has
  them on every file.
- A domain the app created itself gets `fs-inherit` only when one of its filesystems maps `inherit`, and not
  when the domain holds an `FsInheritModel` class of its own. Registering into a domain that already booted is
  an `AuthzConfigError`: resolve the fs providers before the domain's first `AuthzDomains.service()`.
- `inherit` or `policies` on a filesystem checked in root is an `AuthzConfigError` (decorator, and every domain
  boot): root never holds the fs models. Root-wide policies belong in `authz.abac.policies`.
- Where the domain has a `combine` entry, it must list `fs-inherit` for the model to vote; a registered model that
  `combine` leaves out is unrouted, and the host logs a warning at boot.

## fs-abac

`authz.fs.<name>.policies` (the ABAC policy shape of `authz.abac.policies`) become one `AbacModel` named `fs-abac`
in the filesystem's domain, over a `ConfigPolicyStore` of the policies of every filesystem checked there, with its
`AbacContributor` (so a policy naming an unregistered permission fails the domain's boot).

```ts
authz: {
  fs: { uploads: { mode: 'enforce', domain: 'fs',
                   policies: [{ id: 'public', effect: 'permit', permissions: ['fs:read', 'fs:stat'],
                                when: { attr: 'resource.id', glob: 'uploads:public/**' } }] } },
  domains: { fs: { combine: { default: { algorithm: 'deny-overrides', models: ['rbac', 'fs-abac', 'fs-inherit'] } } } },
}
```

- `resource.*` conditions read the path's row `{ id, type, fs, path }` that the guard passes as the subject.
- Policy ids must be unique within a domain: two filesystems with one id are an `AuthzConfigError` naming both.
- A domain the app created gets `fs-abac` too, once; as for `fs-inherit`, a domain that already booted is refused.
  A model of the app named `fs-abac` in that domain fails its boot (two models with one name).
- A deny policy beats permits of other models under `deny-overrides`.
- The model's summary lists each permitted permission, conditional when the policy has a condition or a scope.
- Importing `@spinajs/authz-fs` also loads `@spinajs/authz-abac`, which registers its `authz_policy` migration and
  its admin handlers.
