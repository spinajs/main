# Operation table

The operation table maps each provider method to the permissions it needs on each of its path arguments. The guard checks only what the table names. `authz.fs.<name>.operations` adds methods of your own providers or changes the permission of a single-path method.

## How it works

1. `effectiveFsOperations(config, fsName)` starts from `FS_OPERATIONS` and applies `authz.fs.<fsName>.operations`. The guard computes it once, when it wraps the provider.
2. A call of a method in the table is checked on every path argument the entry names ([Guarded file systems](01-guarded-file-systems.md#how-it-works)).
3. A method in `FS_UNCHECKED_METHODS`, a non-function property or a symbol passes through unchecked.
4. Any other method throws `AuthzConfigError` (`<method> is not in the operation table; map it in authz.fs.<name>.operations`) in `enforce`, unless the principal is `SYSTEM`. In `audit` it logs a warning and runs.
5. At every domain boot, `FsAuthzContributor` declares each permission of the effective table, and each `inherit` key, as a permission ref of the filesystem's domain. A permission nobody registered fails that boot.

### Built-in table

| Method | Checks |
| --- | --- |
| `read`, `readStream`, `download`, `hash`, `metadata` | `fs:read` on the file |
| `exists`, `stat` | `fs:stat` on the file |
| `isDir`, `dirExists` | `fs:stat` on the directory |
| `list(dir)` | `fs:list` on the directory; with `list: 'each'` also `fs:stat` on each entry |
| `write`, `writeStream`, `append` | `fs:write` on the file |
| `mkdir` | `fs:write` on the directory |
| `upload(src, dest?)` | `fs:write` on `dest`, else on the basename of `src` |
| `rm` | `fs:delete` on the path |
| `copy(src, dest, dstFs?)` | `fs:read` on `src`; `fs:write` on `dest` in `dstFs`, else in this filesystem |
| `move(src, dest, dstFs?)` | `fs:read` and `fs:delete` on `src`; `fs:write` on `dest` in `dstFs`, else here |
| `rename(src, dest)` | `fs:read` and `fs:delete` on `src`; `fs:write` on `dest` |
| `zip(srcs, dstFs?, dstFile?)` | `fs:read` on each source; `fs:write` on the archive |
| `unzip(src, dest?, dstFs?)` | `fs:read` on `src`; `fs:write` on the destination directory |
| `signedUrl`, `getSignedUrl` | `fs:share` on the file |

Never checked (`FS_UNCHECKED_METHODS`): `resolvePath`, `tmppath`, `tmpname`, `resolve`, `dispose`, `__checkInstance__`, `constructor`, and the `Object.prototype` members the provider does not override.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authz.fs.<name>.operations.<method>` | `Permission \| Permission[]` | none | a registered permission, or a non-empty list | Checked on argument 0. A new method is checked as a `file`; a replaced one keeps its `file` or `dir` kind. |
| `authz.fs.<name>.list` | `string` | `'dir'` | `dir`, `each` | `dir`: `list` needs `fs:list` on the directory. `each`: every entry also needs `fs:stat`. `enforce` drops the others, `audit` keeps them and warns. |

```ts sample
const config = {
  authz: {
    fs: {
      media: {
        mode: 'enforce',
        // a method of a custom provider, checked as a read of its first argument
        operations: { thumbnail: 'fs:read' },
        // users see only the entries they may stat
        list: 'each',
      },
    },
  },
};

export default config;
```

`effectiveFsOperations()` throws `AuthzConfigError` for:

- a mapping of an unchecked method (`resolvePath`, `tmppath`, ...);
- a mapping that replaces `copy`, `move`, `rename`, `zip`, `unzip` or `upload`. They check more than argument 0, and one check on argument 0 would drop the others.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Permission refs of the filesystems | `AuthzContributor` of `@spinajs/authz`, registered at import in the root container | `FsAuthzContributor` | none | Extend the table through `authz.fs.<name>.operations`. |

Exports:

| Export | Is |
| --- | --- |
| `FS_OPERATIONS` | The built-in table: method → `FsOperation`. |
| `FsOperation` | `{ paths: FsPathSpec[], dstFs? }`: the path arguments and the argument naming a destination filesystem. |
| `FsPathSpec` | One path argument: `arg` index, `permissions`, `kind` (`file` or `dir`), and `onDestination`, `sources`, `default`, `dirSlash`. |
| `FS_UNCHECKED_METHODS` | The methods that pass unchecked. |
| `effectiveFsOperations(config, fsName)` | The table of one filesystem. |
| `fsOperationPermissions(table)` | Method → permission, or the list when a method needs several. |

`FsAuthzContributor.contribute(domain)` also fails every domain boot when:

- a filesystem checked in `root` has `inherit` or `policies` ([File system domains](09-file-system-domains.md));
- the removed key `authz.fsMetadata.connection` is set ([File metadata stores](05-file-metadata-stores.md#migration)).

## Important behaviour

- **`list` and key stores.** The guard hands `list` the directory with a trailing `/`, so a key store does not match `docs.txt` for `docs`.
- **`list: 'each'` checks entries as files.** Each entry is checked with `fs:stat` on a `file` ref, also when it is a directory. Local providers list names, S3 lists whole keys; both are handled.
- **`upload` does not check `src`.** It is a local file outside every filesystem: whoever may write may upload any file the process can read.
- **`rm` of a directory** is checked on the directory only, not on the files under it.
- **Boot refs.** Each mapped permission is declared on its kind and on `fs`, since any path argument may be the filesystem root.

## Best practices

- Map every public method of a custom provider. An unmapped method fails in `enforce`, so a forgotten mapping shows up as an error, not as an open door.
- Prefer `fs:read` or `fs:write` for custom methods. A permission of your own needs `authz.permissions` and grants of its own.

## Patterns and antipatterns

```ts
// Don't: one check on argument 0 would drop the write check on the destination; boot fails
operations: { copy: 'fs:read' }

// Do: grant the permissions the built-in entry checks
roles: { editor: { grants: [{ permission: 'fs:read', on: [{ type: 'fs', id: 'media' }] }, { permission: 'fs:write', on: [{ type: 'fs', id: 'media' }] }] } }
```

## Examples

### Make `rm` need a permission of your own

```ts sample
const config = {
  authz: {
    permissions: {
      'fs:purge': { types: ['fs', 'dir', 'file'] },
    },
    fs: {
      // only holders of fs:purge may delete in the archive
      archive: { mode: 'enforce', operations: { rm: 'fs:purge' } },
    },
  },
};

export default config;
```

Give `fs:purge` to a role through a grant, as any other permission.

## Related

- [Guarded file systems](01-guarded-file-systems.md): when the table is applied.
- [Paths, refs and permissions](02-paths-refs-and-permissions.md): the refs each check names.
- [File operations](../fs/02-file-operations.md): what each method of a provider does.
