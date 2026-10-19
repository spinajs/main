# `@spinajs/authz-fs`

Checks every file action of `@spinajs/fs` providers with `@spinajs/authz` through one `FsMiddleware`, and keeps per-file rights in one ORM table, `fs_acl`.

It does **not** wrap providers, build models or create domains: `getFs(name)` is the provider itself, and a filesystem is checked only when `authz.fs.<name>` says so.

## Install

```sh
npm install @spinajs/authz-fs
```

Import the package before the first file action. The import registers `AuthzFsMiddleware` (order 100), the resource adapter for the `fs:*` permissions and the ACL relations, `OrmFileAclStore`, the `fs_acl` migration and `AuthzUploadMiddleware`. The order against `fsService` does not matter: the middleware is resolved on every action.

## Features

| Feature | What it does |
| --- | --- |
| [Access modes and configuration](01-access-modes-and-configuration.md) | `authz.fs.<name>` and `authz.fsAcl` keys: mode, domain, owner stamping, listing, signed URLs. |
| [Checks on file actions](02-checks-on-file-actions.md) | The `fs:*` permissions, refs, and what `AuthzFsMiddleware` checks per action. |
| [File ACL](03-file-acl.md) | The `fs_acl` table, owners and how rows follow `rm`, `move` and `copy`. |
| [Relation grants](04-relation-grants.md) | Turn ACL relations into permissions with RBAC relation grants. |
| [Managing ACL rows](05-managing-acl-rows.md) | `FsAcl`: grant, revoke and list rows as the current principal. |
| [Uploads and routes](06-uploads-and-routes.md) | `AuthzUploadMiddleware` and `fromFsPath` for `@spinajs/http` routes. |
| [ACL store](07-acl-store.md) | The `FileAclStore` extension point and `OrmFileAclStore`. |

## Quick start

An `uploads` filesystem in `enforce` mode. Users own what they create and may write and read their own files.

```ts sample
import { runWithPrincipal } from '@spinajs/authz';
import '@spinajs/authz-fs';
import { getFs } from '@spinajs/fs';

export const config = {
  authz: {
    fs: { uploads: { mode: 'enforce', stampOwner: true } },
    roles: {
      user: {
        grants: [
          { permission: 'fs:write', relation: 'owner', on: [{ type: 'fs', id: 'uploads' }] },
          { permission: 'fs:read', relation: 'owner', on: [{ type: 'fs', id: 'uploads' }] },
        ],
      },
    },
  },
};

export async function saveAvatar(userId: string, data: Buffer): Promise<void> {
  await runWithPrincipal({ type: 'user', id: userId, authenticated: true, source: 'session', attributes: {} }, async () => {
    await getFs('uploads').write(`avatars/${userId}.png`, data);
  });
}
```

## Related packages

- [`@spinajs/fs`](../fs/07-middlewares.md): the `FsMiddleware` contract and the provider actions.
- [`@spinajs/authz`](../authz/README.md): permissions, domains and the decision engine.
- [`@spinajs/authz-rbac`](../authz/README.md): roles, relation grants and subject keys.
- [`@spinajs/http`](../http/08-file-uploads.md): upload routes.
- [`@spinajs/configuration-http`](../configuration-http/05-file-uploads.md): exclusive uploads of configuration files.
