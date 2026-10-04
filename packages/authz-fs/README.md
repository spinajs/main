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
    (`secret.`, `secret `), which Windows treats as another name for the same file.

Drive and UNC base paths are compared without regard to case, posix base paths exactly, always on whole
segments (`/data/up` is not inside `/data/upload`).

Normalisation keeps the case of the path. On case-insensitive filesystems (NTFS, default APFS) case
variants (`Secret/A.TXT`) and 8.3 short names (`SECRE~1`) reach one file under several ref ids. A grant
that names one form does not match the others, so grants fail closed, but deny rules (an ABAC deny policy
on `resource.id`, or a deny bound to a `dir` ref) do not: another form of the path skips them. Do not rely
on deny rules on fs paths there.
