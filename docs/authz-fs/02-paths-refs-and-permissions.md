# Paths, refs and permissions

Every path the guard checks becomes an authz resource ref, and every check names one of six `fs:*` permissions. `FsResourceAdapter` teaches the engine these refs: their ancestors, their subject row and the `owner` relation. Read this page to grant access to files and directories.

## How it works

1. `normalizeFsPath(path, basePath?)` turns the caller's path into the path the ref ids use:
   - `\` becomes `/`; empty and `.` segments go; `..` removes the segment before it; leading and trailing `/` go. `''`, `.`, `./` and `/` are the root, `''`.
   - An absolute path inside the provider's `Options.basePath` becomes relative to it.
   - Any other path that starts with `/` or `\` and has no drive is read from the filesystem root (`/x` is `x`), as `fsNative.resolvePath` reads it.
2. It throws `InvalidArgument` for a path that:
   - climbs above the root (`../x`, `a/../../x`);
   - holds a NUL byte;
   - is a drive (`C:\x`) or UNC (`\\host\share\x`) path outside the base path;
   - has a segment that holds `:` or ends in `.` or a space (`a.txt::$DATA`, `secret.`, `secret `). Windows reads those as another name of the same file.
3. `fsRef(fsName, path, kind)` builds the ref: `{ type: 'fs', id: fsName }` for the root, else `{ type: kind, id: '<fsName>:<normalised path>' }`. `kind` is `'file'` or `'dir'`, taken from the [operation table](03-operation-table.md).
4. `fsAncestors(ref)` gives `[self, parent directories nearest first, { type: 'fs', id: fsName }, GLOBAL]`. A grant on any of them covers the path.
5. `fsRowOf(fsName, path, type)` builds the subject row `{ id, type, fs, path }`. The guard passes it with every check, so `owner` grants and `resource.*` conditions are decided for that path without IO.

For `uploads:users/42/cv.pdf` the chain is:

| Ref | Covers |
| --- | --- |
| `{ type: 'file', id: 'uploads:users/42/cv.pdf' }` | this file |
| `{ type: 'dir', id: 'uploads:users/42' }` | everything under `users/42` |
| `{ type: 'dir', id: 'uploads:users' }` | everything under `users` |
| `{ type: 'fs', id: 'uploads' }` | the whole filesystem |
| `GLOBAL` | every resource |

## Permissions

`FsResourceAdapter.permissions()` registers these on the types `fs`, `dir` and `file` (`FS_PERMISSIONS`, `FS_RESOURCE_TYPES`):

| Permission | Implies | Needed for |
| --- | --- | --- |
| `fs:read` | `fs:stat` | Read a file's content. |
| `fs:stat` | | Check that a path exists and read its stats. |
| `fs:list` | | List the entries of a directory. |
| `fs:write` | `fs:stat` | Create or change files and directories. |
| `fs:delete` | | Delete files and directories. |
| `fs:share` | | Create a signed URL for a file. |

Which method needs which permission: [Operation table](03-operation-table.md).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Resource adapter | `ResourceAdapter` of `@spinajs/authz`, registered at import in the root container (`@Injectable(ResourceAdapter)`) | `FsResourceAdapter` (`kind` `'fs'`) | none | Not meant to be replaced: the guard builds refs and rows itself. Give paths extra parents with an [`FsPathResolver`](10-inherited-access.md). |

`FsResourceAdapter` members:

| Member | Returns |
| --- | --- |
| `accepts(target)` | `true` for a plain object `{ fs, path, kind? }`, so `authz().check({ resource: { fs: 'uploads', path: 'a.pdf' } })` works. |
| `refOf(target)` | The ref of the target, normalised with the base path of the published provider. `kind` defaults to `'file'`. |
| `ancestors(ref)` | `fsAncestors(ref)`. |
| `load(ref)` | The subject row, built without IO; `null` for a ref that is not an fs ref. |
| `relations()` | `owner` on `file`, `dir` and `fs`, read from the [file metadata store](04-file-owners.md#the-owner-relation). |
| `operations()` | Method → permission of the built-in operation table. |

Ref helpers:

| Function | Does |
| --- | --- |
| `normalizeFsPath(path, basePath?)` | The canonical path, or `InvalidArgument`. |
| `fsRef(fsName, path, kind)` | The ref of a path. |
| `parseFsRef(ref)` | `{ fs, path, type }`, or `undefined` for a ref that is not in the form `fsRef` builds. |
| `fsRow(ref)`, `fsRowOf(fsName, path, type)` | The subject row. |
| `fsAncestors(ref)` | The ancestor chain; `null` for a ref `parseFsRef` refuses. |

## Important behaviour

- **The checked path is the accessed path.** The guard hands the normalised path, not the caller's, to the raw provider. On key stores such as S3, `/x` and `x` would otherwise be two keys.
- **Case.** Normalisation keeps the case of a path. On case-insensitive disks (NTFS, default APFS) `Secret/A.TXT` and `secret/a.txt` are one file under two ref ids. Grants fail closed there, but a deny bound to one form does not stop the other.
- **Colons.** A key with `:` (`logs/2026-10-04T10:00.txt`) cannot be reached through a guarded filesystem, on S3 too.
- **Base paths.** Drive and UNC base paths compare without case, posix base paths exactly, always on whole segments: `/data/up` is not inside `/data/upload`.
- **Filesystem names** must not hold `:`; the first `:` of a ref id ends the name.
- **Unknown filesystems.** `fsAncestors` does not know which filesystems exist. A ref of a missing filesystem still gets a chain, and it grants nothing.

## Best practices

- Grant on the widest ref that is correct: `fs` for a whole filesystem, `dir` for a tree. Grants on single `file` refs grow without bound.
- Use the `{principal.id}` template in a grant's `on` pattern to give each user one directory.
- Do not rely on deny rules on fs paths on case-insensitive disks. Grant less instead.

## Patterns and antipatterns

```ts
// Don't: a hand-built id skips normalisation; 'uploads:/a.pdf' never matches a check
const ref = { type: 'file', id: `uploads:${req.params.path}` };

// Do: build it as the guard does
const ref = fsRef('uploads', req.params.path, 'file');
```

## Examples

### Give each user a private directory and a shared public one

```ts sample
const config = {
  authz: {
    fs: { uploads: { mode: 'enforce' } },
    rbac: {
      roles: {
        user: {
          grants: [
            // users/<own id>/ and everything under it
            { permission: 'fs:read', on: [{ type: 'dir', id: 'uploads:users/{principal.id}' }] },
            { permission: 'fs:write', on: [{ type: 'dir', id: 'uploads:users/{principal.id}' }] },
            { permission: 'fs:delete', on: [{ type: 'dir', id: 'uploads:users/{principal.id}' }] },
            // everyone reads public/
            { permission: 'fs:read', on: [{ type: 'dir', id: 'uploads:public' }] },
            { permission: 'fs:list', on: [{ type: 'dir', id: 'uploads:public' }] },
          ],
        },
      },
    },
  },
};

export default config;
```

### Show a download button only when the user may read the file

```ts sample
import { authz, currentPrincipal } from '@spinajs/authz';
import { fsRef, fsRow } from '@spinajs/authz-fs';

export async function canDownload(path: string): Promise<boolean> {
  const ref = fsRef('uploads', path, 'file');
  // The row settles owner grants and resource.* conditions; without it they stay a residual.
  const decision = await authz().check({ principal: currentPrincipal(), permission: 'fs:read', resource: ref, subject: fsRow(ref) });
  return decision.allowed && decision.residual.op === 'true';
}
```

## Related

- [Authorization in SpinaJS](../authz/01-check-flow.md#concepts): resources, ancestors and permissions.
- [The RBAC model](../authz-rbac/README.md): roles, grants and `on` patterns.
- [Operation table](03-operation-table.md): which permission each method needs.
- [Route checks with `fromFsPath`](08-route-checks-with-fromfspath.md): the same refs for an HTTP route.
