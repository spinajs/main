# ACL store

`FileAclStore` is where the file ACL rows live. `OrmFileAclStore` keeps them in the `fs_acl` table; replace it to keep them elsewhere.

## How it works

1. `AuthzFsMiddleware`, `FsAclRelation` and `FsAcl` resolve `FileAclStore` from the root container on every use; the last registration wins.
2. Importing `@spinajs/authz-fs` registers `OrmFileAclStore` with `@Injectable(FileAclStore)`.
3. Paths reach the store normalised, without a base path (`''` is the root). Subject keys are the `subjectKeyOf` keys of `@spinajs/authz-rbac`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `FileAclStore` | `FileAclStore`, root singleton, registered by `@Injectable(FileAclStore)` in `src/acl/orm-store.ts` | `OrmFileAclStore` | Any subclass | `DI.register(MyStore).as(FileAclStore)` before the first file action of a checked filesystem. |

| Method | Called by |
| --- | --- |
| `holds(fs, paths, subjectKeys, relation, at)` | `FsAclRelation`: a live row of `relation` at one of `paths` names one of `subjectKeys`. |
| `list(fs, path)` | `FsAcl.list`: the rows at exactly `path`, expired ones included. |
| `grant(row)` | `FsAcl.grant`. Idempotent on `(fs, path, subject, relation)`: a second grant replaces `expiresAt` and `grantedBy`. |
| `revoke(fs, path, subjectKey, relation)` | `FsAcl.revoke`. |
| `ownerOf(fs, path)` | The principal of the oldest `owner` row at exactly `path`; `null` without one. `authz-fs` does not call it; it is for your own code. |
| `setOwnerIfAbsent(fs, path, owner)` | `AuthzFsMiddleware` with `stampOwner`: first writer wins. |
| `deleteTree(fs, path)` | The rows at `path` and under it; `''` takes the whole filesystem. Used for stale rows, for `rm` of a directory or of a path with entries under it (an S3 prefix), and when a `move` or `rename` lands on an occupied destination. |
| `deletePath(fs, path)` | The rows at exactly `path`. Used for `rm` of a file with nothing under it and when a `move` or `rename` lands on an occupied destination. |
| `moveTree(fromFs, from, toFs, to)` | `move` and `rename` of a directory: rows at `from` and under it move; a moved row replaces an equal one. A row whose new path would exceed 512 characters is deleted. |
| `movePath(fromFs, from, toFs, to)` | `move` and `rename` of anything else: only the rows at exactly `from`. |

### FileAclStore: custom implementation

Replace the store to keep rows in another database or, as here, in memory for tests. Register it before the first checked file action.

```ts sample
import type { PrincipalRef } from '@spinajs/authz';
import { FileAclStore, FsAcl } from '@spinajs/authz-fs';
import type { FsAclRow } from '@spinajs/authz-fs';
import { subjectKeyOf } from '@spinajs/authz-rbac';
import { DI } from '@spinajs/di';
import { getFs } from '@spinajs/fs';

export class MemoryFileAclStore extends FileAclStore {
  private rows: FsAclRow[] = [];

  private same(a: FsAclRow, b: FsAclRow): boolean {
    return a.fs === b.fs && a.path === b.path && a.relation === b.relation && subjectKeyOf(a.subject) === subjectKeyOf(b.subject);
  }

  private under(path: string, root: string): boolean {
    return root === '' || path === root || path.startsWith(`${root}/`);
  }

  async holds(fs: string, paths: readonly string[], subjectKeys: readonly string[], relation: string, at: Date): Promise<boolean> {
    return this.rows.some(
      (r) => r.fs === fs && r.relation === relation && paths.includes(r.path) && subjectKeys.includes(subjectKeyOf(r.subject)) && (!r.expiresAt || r.expiresAt > at),
    );
  }

  async list(fs: string, path: string): Promise<readonly FsAclRow[]> {
    return this.rows.filter((r) => r.fs === fs && r.path === path);
  }

  async grant(row: FsAclRow): Promise<void> {
    this.rows = [...this.rows.filter((r) => !this.same(r, row)), row];
  }

  async revoke(fs: string, path: string, subjectKey: string, relation: string): Promise<void> {
    this.rows = this.rows.filter((r) => !(r.fs === fs && r.path === path && r.relation === relation && subjectKeyOf(r.subject) === subjectKey));
  }

  async ownerOf(fs: string, path: string): Promise<PrincipalRef | null> {
    const row = this.rows.find((r) => r.fs === fs && r.path === path && r.relation === 'owner' && !('set' in r.subject) && r.subject.id !== '*');
    return row && !('set' in row.subject) ? { type: row.subject.type, id: row.subject.id } : null;
  }

  async setOwnerIfAbsent(fs: string, path: string, owner: PrincipalRef): Promise<void> {
    if (!this.rows.some((r) => r.fs === fs && r.path === path && r.relation === 'owner')) await this.grant({ fs, path, subject: owner, relation: 'owner' });
  }

  async deleteTree(fs: string, path: string): Promise<void> {
    this.rows = this.rows.filter((r) => !(r.fs === fs && this.under(r.path, path)));
  }

  async deletePath(fs: string, path: string): Promise<void> {
    this.rows = this.rows.filter((r) => !(r.fs === fs && r.path === path));
  }

  async moveTree(fromFs: string, from: string, toFs: string, to: string): Promise<void> {
    await this.move(fromFs, from, toFs, to, (r) => this.under(r.path, from));
  }

  async movePath(fromFs: string, from: string, toFs: string, to: string): Promise<void> {
    await this.move(fromFs, from, toFs, to, (r) => r.path === from);
  }

  private async move(fromFs: string, from: string, toFs: string, to: string, picks: (r: FsAclRow) => boolean): Promise<void> {
    const moved = this.rows.filter((r) => r.fs === fromFs && picks(r));
    this.rows = this.rows.filter((r) => !moved.includes(r));
    for (const r of moved) {
      const rest = from === '' ? r.path : r.path.slice(from.length + 1);
      const path = to === '' ? rest : rest === '' ? to : `${to}/${rest}`;
      if (path.length <= 512) await this.grant({ ...r, fs: toFs, path });
    }
  }
}

export async function shareAndRead(): Promise<void> {
  DI.register(MemoryFileAclStore).as(FileAclStore);

  await new FsAcl().grant('uploads', 'reports', { type: 'user', id: 'alice' }, 'viewer');
  await getFs('uploads').read('reports/q1.txt');
}
```

## Important behaviour

- `AuthzFsMiddleware` and `FsAclRelation` read paths and keys exactly: a store must compare them case-sensitively, as `OrmFileAclStore` does with binary collation.
- A store must hold paths up to 512 characters and subject keys up to 200, and refuse longer ones, as `OrmFileAclStore` does with `InvalidArgument`.
- `holds` must ignore expired rows (`expiresAt` before `at`).

## Related

- [File ACL](03-file-acl.md): the default table and when rows change.
- [Managing ACL rows](05-managing-acl-rows.md): `FsAcl`, the checked facade.
