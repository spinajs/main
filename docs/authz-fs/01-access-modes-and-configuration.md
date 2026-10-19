# Access modes and configuration

`authz.fs.<name>` turns checks on for one filesystem and chooses how strict they are. `authz.fsAcl` configures the file ACL.

## How it works

1. `fsAccessConfig(fsName, container?)` reads `authz.fs.<fsName>` on every call. A filesystem without an entry is `off`.
2. `AuthzFsMiddleware.isEnabled(fs)` is `true` when the mode is not `off`. An action whose every filesystem is `off` runs no check, probe or ACL update. A `move` into an `off` filesystem still moves the rows, and the destination is probed.
3. Each target of an action uses the entry of its own filesystem. In `copy(src, dst, dstFs)` the source can be `enforce` while `dstFs` is `audit` or `off`.
4. A missing `Configuration` while an `AuthzService` runs throws `AuthzConfigError`: the middleware fails closed.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authz.fs.<name>.mode` | `string` | none, required in an entry | `off`, `audit`, `enforce` | `off`: no checks. `audit`: check, warn on a denial, go on. `enforce`: a denial or a conditional permit throws `AccessDenied` (403). |
| `authz.fs.<name>.domain` | `string` | `root` | a domain from `authz.domains` | The authz domain the checks run in. It must exist, else `AuthzConfigError` on first use; authz-fs never creates one. |
| `authz.fs.<name>.stampOwner` | `boolean` | `false` | `true`, `false` | A path an action creates gets an `owner` row for the first writer. |
| `authz.fs.<name>.list` | `string` | `dir` | `dir`, `each` | `dir`: `list` needs `fs:list` on the directory. `each`: each entry also needs `fs:stat`. |
| `authz.fs.<name>.signedUrl.defaultTtlSeconds` | `number` | `900` | greater than `0` | Lifetime of a signed URL when the caller asks for none. |
| `authz.fs.<name>.signedUrl.maxTtlSeconds` | `number` | none | greater than `0` | Cap on the lifetime of any signed URL. |
| `authz.fsAcl.connection` | `string` | `default` | an ORM connection name | Connection of `OrmFileAclStore` and of the `fs_acl` migration. |
| `authz.fsAcl.relations` | `string[]` | `['owner', 'editor', 'viewer']` | unique names of 1-64 characters | The relations an ACL row may name. `owner` is always served, first. |

```ts
{
  authz: {
    fs: {
      uploads: { mode: 'enforce', stampOwner: true },
      archive: { mode: 'audit', list: 'each', signedUrl: { maxTtlSeconds: 3600 } },
    },
    fsAcl: { connection: 'default', relations: ['owner', 'editor', 'viewer'] },
  },
}
```

## Important behaviour

- An unknown key under `authz.fs.<name>` or `authz.fsAcl` fails boot with `InvalidConfiguration`: the schemas close their objects with `propertyNames`.
- A configuration no schema checked (`Configuration.set`, tests) throws `AuthzConfigError` for an unknown key, so a key of the removed guard (`metadata`, `resolver`, `inherit`, `policies`, `operations`) never passes silently.
- An entry without `mode` is refused: an entry with other keys must not be silently `off`.
- `audit` writes a warning per missing permission and lets the action run.

## Best practices

- Add `authz.fs.<name>` entries only for filesystems you want checked; every other one stays `off`.
- Start a new filesystem in `audit`, read the warnings, then switch to `enforce`.

## Related

- [Checks on file actions](02-checks-on-file-actions.md): what each mode checks.
- [File ACL](03-file-acl.md): `stampOwner` and the `fs_acl` table.
- [`@spinajs/fs` middlewares](../fs/07-middlewares.md): how the middleware chain is resolved.
