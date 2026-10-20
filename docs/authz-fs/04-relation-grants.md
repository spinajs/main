# Relation grants

ACL rows hold relations, not permissions. `@spinajs/authz-fs` depends on `@spinajs/authz-rbac`, which provides the relation grants, the subject keys and the `RbacService`. A relation becomes a permission only through an RBAC relation grant: "holders of `editor` on this filesystem get `fs:write`".

## How it works

1. A role lists grants with a `relation` and the resources they apply to, for example `{ permission: 'fs:write', relation: 'editor', on: [{ type: 'fs', id: 'uploads' }] }`.
2. `FsResourceAdapter.relations()` returns one `FsAclRelation` per ref type (`fs`, `dir`, `file`) and per relation of `authz.fsAcl.relations`. Boot rule 8 needs a resolver for every relation a grant names, so another `RelationResolver` for one of them fails the boot.
3. On a check, `FsAclRelation.holds(principal, ref)` takes the subject keys from `RbacService.subjectKeysOf(principal)` of the `RbacService` in the domain `authz.fs.<fs>.domain`: the principal itself, its companions, type wildcards and live subject sets, direct and nested.
4. It builds the path chain of the ref up to the root `''` and asks the `FileAclStore` once (`holds`) for a live row of the relation at one of those paths with one of those subject keys.
5. A grant on the `fs` ref covers every path of the filesystem, because the ref chain of a path ends at `{ type: 'fs', id: <name> }`.

## Configuration

Roles and their grants are RBAC configuration under `authz.rbac.roles`. Owners get everything, editors write, viewers read and list. The first grant has no relation: it lets users create files in `avatars`.

```ts
{
  authz: {
    rbac: {
      roles: {
        user: {
          grants: [
            { permission: 'fs:write', on: [{ type: 'dir', id: 'uploads:avatars' }] },
            { permission: 'fs:*', relation: 'owner', on: [{ type: 'fs', id: 'uploads' }] },
            { permission: 'fs:write', relation: 'editor', on: [{ type: 'fs', id: 'uploads' }] },
            { permission: 'fs:read', relation: 'viewer', on: [{ type: 'fs', id: 'uploads' }] },
            { permission: 'fs:list', relation: 'viewer', on: [{ type: 'fs', id: 'uploads' }] },
          ],
        },
      },
    },
  },
}
```

## Important behaviour

- The subject the engine passes to the resolver is ignored: a caller-built row could claim anything. Only the principal counts.
- Without an `RbacService` in the domain, the keys are the principal and its type wildcard. The same holds for a domain whose `AuthzService` runs no `rbac` model, even when a parent domain registers an `RbacService`.
- Under a role ceiling (a role switch), a set row counts only through a membership whose role passes `ceiling.roles`, and nested sets do not count.
- `system`, `unattended`, `anonymous` and `link` principals hold no relation.
- Known limit: `holds` never sees the `fresh` flag of a request, so subject keys come through the RBAC model's assignment cache and a set membership may lag by its TTL.
- `FsAclRelation` is not `listable`: a relation grant on `fs:*` is checked per file. For listable relations on columns see [Column relations](../authz/12-column-relations.md).
- Relation grants cover existing paths only. Creating a file needs a grant without a relation, or a row on a parent directory, because a new path has no owner row yet.
- Rows expire: a row with a past `expires_at` does not count.

## Best practices

- Grant `fs:*` to `owner` only if owners may re-delegate: `fs:manage` lets the holder grant any configured relation, `owner` included.
- Keep relation names few; every relation adds three resolvers (one per ref type).

## Related

- [File ACL](03-file-acl.md): where the rows live.
- [Managing ACL rows](05-managing-acl-rows.md): create the rows.
- [`@spinajs/authz`](../authz/README.md): roles, grants and domains.
