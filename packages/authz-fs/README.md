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

- After a successful `write`, `upload`, `copy` (destination), `zip` (the archive) and `unzip` (the destination
  directory) the owner becomes the principal. `writeStream` stamps when the stream closes after it finished, and
  holds the `'close'` event back until then; a stream that failed or was destroyed stamps nothing. `append` and
  `mkdir` stamp only what they create: an existing file keeps its owner, also when it has none.
- The owner is the principal the decision ran for: under `inherit` delegation the delegate, as the owner relation
  is then evaluated for the delegate too; under `intersect` the agent. SYSTEM, UNATTENDED and anonymous principals
  own nothing, and their writes keep the previous owner.
- Scope and tags of a file survive its writes. `rm` deletes the metadata, `move` and `rename` move it, also to
  another filesystem's store (to a filesystem without one it is dropped). This happens with or without
  `stampOwner` once a store is configured. Unchecked calls a provider makes inside an operation keep no metadata.
- A metadata update that fails after the IO is logged at error and its error rethrown (for `writeStream`: emitted to
  the stream's `'error'` listeners), since a lost owner row denies the owner later. The read before the IO and the
  write after it are not one transaction.
- `unzip` stamps the destination directory, not the files it extracts.

`FsResourceAdapter.relations()` serves `owner` on `file`, `dir` and `fs` (boot rule 8 asks for every type of the
permission). It holds when the store records the principal's `{ type, id }` for that path; it reads the store, never
the subject, and does not hold for the filesystem root or a filesystem without a store.

Stores:

- `OrmFileMetadataStore`: table `fs_object` (migration `AuthzFsObject_2026_10_01_00_00_00` on the `default`
  connection), one row per filesystem and normalised path. It uses the connection
  `authz.fsMetadata.connection` names (not under `authz.fs`, which is keyed by filesystem name), else `default`.
  `delete` and `move` take the rows under a directory path along. Paths are limited to 512 characters.
- `S3ObjectMetadataStore`: the metadata lives on the object as the user metadata `x-amz-meta-authz-meta`
  (URI-encoded JSON, within S3's 2 KB). It needs `getMetadata` and `setMetadata` (fsS3) on the provider and calls
  the raw provider behind the guard. `fsS3.setMetadata` copies the object onto itself, so objects over 5 GB cannot
  be stamped. Whoever can PUT objects into the bucket directly (bucket credentials, a presigned PUT) can set any
  owner.
