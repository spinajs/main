import type { PrincipalRef } from '@spinajs/authz';
import { InvalidArgument } from '@spinajs/exceptions';

import { FS_ACL_LIMITS, FS_ACL_OWNER, FileAclStore } from '../../src/index.js';
import type { FsAclRow } from '../../src/index.js';
import { aclExpiry, aclFs, aclOwnerKey, aclPath, aclRelation, aclSubjectKey, checkMove, fits, isUnder, isWildcardKey, movedPath, subjectOfKey } from '../../src/acl/shared.js';

export interface MemoryAclRow {
  readonly fs: string;
  readonly path: string;
  readonly subjectKey: string;
  readonly relation: string;
  readonly expiresAt?: Date;
  readonly grantedBy?: string;
}

type Method = 'holds' | 'list' | 'grant' | 'revoke' | 'ownerOf' | 'setOwnerIfAbsent' | 'deleteTree' | 'deletePath' | 'moveTree' | 'movePath';

/** FileAclStore over an array, with OrmFileAclStore's semantics; records each call and fails the methods in `failing`. */
export class MemoryFileAclStore extends FileAclStore {
  readonly rows: MemoryAclRow[] = [];
  readonly calls: string[] = [];
  readonly failing = new Set<Method>();

  clear(): void {
    this.rows.length = 0;
    this.calls.length = 0;
    this.failing.clear();
  }

  /** The subject key of the first owner row at exactly that path. */
  owner(fs: string, path: string): string | undefined {
    return this.rows.find((r) => r.fs === fs && r.path === path && r.relation === FS_ACL_OWNER)?.subjectKey;
  }

  async holds(fs: string, paths: readonly string[], subjectKeys: readonly string[], relation: string, at: Date): Promise<boolean> {
    this.record('holds', fs, paths.join('|'), relation);
    const wanted = paths.map(aclPath);
    return this.rows.some((r) => r.fs === fs && r.relation === relation && wanted.includes(r.path) && subjectKeys.includes(r.subjectKey) && (r.expiresAt === undefined || r.expiresAt.getTime() > at.getTime()));
  }

  async list(fs: string, path: string): Promise<readonly FsAclRow[]> {
    this.record('list', fs, path);
    const f = aclFs(fs);
    const p = aclPath(path);
    return this.rows
      .filter((r) => r.fs === f && r.path === p)
      .map((r) => ({ fs: r.fs, path: r.path, subject: subjectOfKey(r.subjectKey, 'memory row'), relation: r.relation, ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}), ...(r.grantedBy ? { grantedBy: r.grantedBy } : {}) }));
  }

  async grant(row: FsAclRow): Promise<void> {
    this.record('grant', row.fs, row.path, row.relation);
    const key = { fs: aclFs(row.fs), path: aclPath(row.path), subjectKey: aclSubjectKey(row.subject), relation: aclRelation(row.relation) };
    const expiresAt = aclExpiry(row.expiresAt);
    const grantedBy = row.grantedBy === undefined ? undefined : fits(row.grantedBy, 'granted_by');
    const next: MemoryAclRow = { ...key, ...(expiresAt ? { expiresAt } : {}), ...(grantedBy ? { grantedBy } : {}) };
    const at = this.rows.findIndex((r) => r.fs === key.fs && r.path === key.path && r.subjectKey === key.subjectKey && r.relation === key.relation);
    if (at >= 0) this.rows[at] = next;
    else this.rows.push(next);
  }

  async revoke(fs: string, path: string, subjectKey: string, relation: string): Promise<void> {
    this.record('revoke', fs, path, subjectKey, relation);
    const p = aclPath(path);
    this.remove((r) => r.fs === fs && r.path === p && r.subjectKey === subjectKey && r.relation === relation);
  }

  async ownerOf(fs: string, path: string): Promise<PrincipalRef | null> {
    this.record('ownerOf', fs, path);
    const p = aclPath(path);
    for (const r of this.rows) {
      if (r.fs !== fs || r.path !== p || r.relation !== FS_ACL_OWNER || isWildcardKey(r.subjectKey)) continue;
      const subject = subjectOfKey(r.subjectKey, 'memory row');
      if (!('set' in subject)) return { type: subject.type, id: subject.id };
    }
    return null;
  }

  async setOwnerIfAbsent(fs: string, path: string, owner: PrincipalRef): Promise<void> {
    this.record('setOwnerIfAbsent', fs, path);
    const key = { fs: aclFs(fs), path: aclPath(path), subjectKey: aclOwnerKey(owner), relation: FS_ACL_OWNER };
    if (this.rows.some((r) => r.fs === key.fs && r.path === key.path && r.relation === FS_ACL_OWNER)) return;
    this.rows.push(key);
  }

  async deleteTree(fs: string, path: string): Promise<void> {
    this.record('deleteTree', fs, path);
    const p = aclPath(path);
    this.remove((r) => r.fs === fs && isUnder(r.path, p));
  }

  async deletePath(fs: string, path: string): Promise<void> {
    this.record('deletePath', fs, path);
    const p = aclPath(path);
    this.remove((r) => r.fs === fs && r.path === p);
  }

  async moveTree(fromFs: string, from: string, toFs: string, to: string): Promise<void> {
    this.record('moveTree', fromFs, from, toFs, to);
    const src = aclPath(from);
    const dst = aclPath(to);
    if (fromFs === toFs && src === dst) return;
    checkMove(fromFs, src, toFs, dst);
    const moving = this.rows.filter((r) => r.fs === fromFs && isUnder(r.path, src));
    const moved = moving.map((r) => ({ ...r, fs: toFs, path: movedPath(src, dst, r.path) })).filter((r) => r.path.length <= FS_ACL_LIMITS.path);
    const sources = new Set(moving.map((r) => r.path));
    if (fromFs === toFs && moved.some((m) => sources.has(m.path))) throw new InvalidArgument(`cannot move ${fromFs}:${src} onto ${dst}, which holds it`, 'to');
    this.remove((r) => moving.includes(r) || moved.some((m) => m.fs === r.fs && m.path === r.path && m.subjectKey === r.subjectKey && m.relation === r.relation));
    this.rows.push(...moved);
  }

  async movePath(fromFs: string, from: string, toFs: string, to: string): Promise<void> {
    this.record('movePath', fromFs, from, toFs, to);
    const src = { fs: aclFs(fromFs), path: aclPath(from) };
    const dst = { fs: aclFs(toFs), path: aclPath(to) };
    if (src.fs === dst.fs && src.path === dst.path) return;
    const moving = this.rows.filter((r) => r.fs === src.fs && r.path === src.path);
    const moved = moving.map((r) => ({ ...r, ...dst }));
    this.remove((r) => moving.includes(r) || (r.fs === dst.fs && r.path === dst.path && moved.some((m) => m.subjectKey === r.subjectKey && m.relation === r.relation)));
    this.rows.push(...moved);
  }

  private remove(match: (r: MemoryAclRow) => boolean): void {
    for (let i = this.rows.length - 1; i >= 0; i--) if (match(this.rows[i])) this.rows.splice(i, 1);
  }

  private record(method: Method, ...args: string[]): void {
    this.calls.push(`${method} ${args.join(' ')}`);
    if (this.failing.has(method)) throw new Error(`${method} failed`);
  }
}
