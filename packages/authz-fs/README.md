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
