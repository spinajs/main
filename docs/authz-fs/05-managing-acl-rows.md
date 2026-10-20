# Managing ACL rows

`FsAcl` grants, revokes and lists file ACL rows as the current principal. Use it for application features such as "share this folder".

## How it works

1. `new FsAcl(options?)` is a plain class, not in DI. Its options replace the container, the decision service, the principal, the logger or the store (mostly for tests).
2. Each call normalises the path against the base path of the published provider of `fs`. A filesystem with no published provider is an `AuthzConfigError`.
3. `grant` and `revoke` refuse a relation outside `authz.fsAcl.relations` (`AuthzConfigError`).
4. `FsAcl` asserts `fs:manage` for the current principal on both refs of the path, `file:<fs>:<path>` and `dir:<fs>:<path>` (`fs:<name>` at the root), in the domain of `authz.fs.<fs>.domain`. Only `SYSTEM` is exempt. A denial throws `AccessDenied`.
5. The `FileAclStore` writes or reads the row.

## Methods

| Method | Effect |
| --- | --- |
| `grant(fs, path, subject, relation, { expiresAt? })` | Adds the row; granting an equal row again replaces `expiresAt` and `grantedBy`. |
| `revoke(fs, path, subject, relation)` | Removes the row. |
| `list(fs, path)` | The rows at exactly `path`, expired ones included. |

## Important behaviour

- The check always enforces, whatever the filesystem's mode, even for `off` and `audit`.
- `fs:manage` lets the holder grant any configured relation, `owner` included. A policy that gives owners `fs:*` lets them re-delegate.
- System code that needs unchecked writes uses [`FileAclStore`](07-acl-store.md) directly.
- A row granted on a path that does not exist yet is cleared as stale when the path is created through the middleware on a checked (not `off`) filesystem.

## Examples

### Share a folder with a team for 7 days

```ts sample
import { FsAcl } from '@spinajs/authz-fs';

export async function shareWithTeam(folder: string, teamId: string): Promise<void> {
  const week = new Date(Date.now() + 7 * 24 * 3600 * 1000);

  await new FsAcl().grant(
    'uploads',
    folder,
    { set: { role: 'team.member', scope: { type: 'team', id: teamId } } },
    'viewer',
    { expiresAt: week },
  );
}
```

## Related

- [Relation grants](04-relation-grants.md): the grants that make `viewer` mean `fs:read`.
- [File ACL](03-file-acl.md): the rows.
- [ACL store](07-acl-store.md): unchecked access for system code.
