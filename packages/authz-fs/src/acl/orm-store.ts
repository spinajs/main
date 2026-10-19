import { randomUUID } from 'node:crypto';

import { AuthzConfigError } from '@spinajs/authz';
import type { PrincipalRef } from '@spinajs/authz';
import { toDate } from '@spinajs/authz-rbac';
import { DI, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { LIKE_ESCAPE_CHARACTER, Orm, RawQuery, escapeLikeValue } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { chunk } from '@spinajs/util';

import { FS_ACL_CONNECTION_KEY, FS_ACL_OWNER, fsAclConfig } from '../access-config/acl-config.js';
import { FS_ACL_TABLE, aclExpiry, aclFs, aclOwnerKey, aclPath, aclPathHash, aclRelation, aclSubjectKey, checkMove, fits, isWildcardKey, movedPath, subjectOfKey } from './shared.js';
import { FileAclStore } from './store.js';
import type { FsAclRow } from './store.js';

interface Row {
  readonly id: string;
  readonly fs: string;
  readonly path: string;
  readonly path_hash: string;
  readonly subject_key: string;
  readonly relation: string;
  readonly expires_at: unknown;
  readonly granted_by: string | null;
  readonly created_at: unknown;
}

export interface OrmFileAclStoreOptions {
  /** The ORM connection; default `authz.fsAcl.connection`, else 'default'. */
  readonly connection?: string;
  /** Where Configuration and Orm are resolved; default the DI root. */
  readonly container?: IContainer;
}

const IN_CHUNK = 500;

/**
 * FileAclStore over `fs_acl` (migration AuthzFsAcl_2026_10_17_00_00_00). Reads are narrowed in SQL by `path_hash`
 * (the indexed key) and decided by an exact comparison of `path` in code, and rows change by id, so a table created
 * with a case-insensitive collation never merges two paths.
 */
@Injectable(FileAclStore)
export class OrmFileAclStore extends FileAclStore {
  constructor(private readonly opts: OrmFileAclStoreOptions = {}) {
    super();
  }

  async holds(fs: string, paths: readonly string[], subjectKeys: readonly string[], relation: string, at: Date): Promise<boolean> {
    const f = aclFs(fs);
    const r = aclRelation(relation);
    const wanted = [...new Set(paths.map(aclPath))];
    const keys = [...new Set(subjectKeys)];
    if (wanted.length === 0 || keys.length === 0) return false;
    const hashes = wanted.map(aclPathHash);
    const driver = await this.driver();
    for (const part of chunk(keys, IN_CHUNK)) {
      const rows = ((await driver.select().from(FS_ACL_TABLE).where({ fs: f, relation: r }).whereIn('path_hash', hashes).whereIn('subject_key', part)) ?? []) as Row[];
      if (rows.some((row) => row.fs === f && row.relation === r && wanted.includes(row.path) && part.includes(row.subject_key) && live(row, at))) return true;
    }
    return false;
  }

  async list(fs: string, path: string): Promise<readonly FsAclRow[]> {
    const f = aclFs(fs);
    const p = aclPath(path);
    return (await exactRows(await this.driver(), f, p)).map(rowOf);
  }

  async grant(row: FsAclRow): Promise<void> {
    const key = { fs: aclFs(row.fs), path: aclPath(row.path), subject_key: aclSubjectKey(row.subject), relation: aclRelation(row.relation) };
    const values = { expires_at: aclExpiry(row.expiresAt), granted_by: row.grantedBy === undefined ? null : fits(row.grantedBy, 'granted_by') };
    const driver = await this.driver();
    await driver.transaction(async (tx) => {
      const found = (await exactRows(tx, key.fs, key.path)).find((r) => r.subject_key === key.subject_key && r.relation === key.relation);
      if (found) await tx.update().in(FS_ACL_TABLE).update(values).where({ id: found.id });
      else await tx.insert().into(FS_ACL_TABLE).values({ id: randomUUID(), ...key, path_hash: aclPathHash(key.path), ...values, created_at: new Date() });
    });
  }

  async revoke(fs: string, path: string, subjectKey: string, relation: string): Promise<void> {
    const f = aclFs(fs);
    const p = aclPath(path);
    const r = aclRelation(relation);
    const driver = await this.driver();
    await driver.transaction(async (tx) =>
      deleteIds(
        tx,
        (await exactRows(tx, f, p)).filter((row) => row.subject_key === subjectKey && row.relation === r).map((row) => row.id),
      ),
    );
  }

  async ownerOf(fs: string, path: string): Promise<PrincipalRef | null> {
    const rows = (await exactRows(await this.driver(), aclFs(fs), aclPath(path))).filter((r) => r.relation === FS_ACL_OWNER && !isWildcardKey(r.subject_key));
    for (const row of oldestFirst(rows)) {
      const subject = subjectOfKey(row.subject_key, `${FS_ACL_TABLE} row ${row.id}`);
      if (!('set' in subject)) return { type: subject.type, id: subject.id };
    }
    return null;
  }

  async setOwnerIfAbsent(fs: string, path: string, owner: PrincipalRef): Promise<void> {
    const key = { fs: aclFs(fs), path: aclPath(path), subject_key: aclOwnerKey(owner), relation: FS_ACL_OWNER };
    const driver = await this.driver();
    await driver.transaction(async (tx) => {
      if ((await exactRows(tx, key.fs, key.path)).some((r) => r.relation === FS_ACL_OWNER)) return;
      await tx.insert().into(FS_ACL_TABLE).values({ id: randomUUID(), ...key, path_hash: aclPathHash(key.path), expires_at: null, granted_by: null, created_at: new Date() });
    });
  }

  async deleteTree(fs: string, path: string): Promise<void> {
    const f = aclFs(fs);
    const p = aclPath(path);
    const driver = await this.driver();
    await driver.transaction(async (tx) => deleteIds(tx, (await tree(tx, f, p)).map((r) => r.id)));
  }

  async deletePath(fs: string, path: string): Promise<void> {
    const f = aclFs(fs);
    const p = aclPath(path);
    const driver = await this.driver();
    await driver.transaction(async (tx) => deleteIds(tx, (await exactRows(tx, f, p)).map((r) => r.id)));
  }

  async moveTree(fromFs: string, from: string, toFs: string, to: string): Promise<void> {
    const src = { fs: aclFs(fromFs), path: aclPath(from) };
    const dst = { fs: aclFs(toFs), path: aclPath(to) };
    if (src.fs === dst.fs && src.path === dst.path) return;
    checkMove(src.fs, src.path, dst.fs, dst.path);
    const driver = await this.driver();
    await driver.transaction(async (tx) => {
      const rows = await tree(tx, src.fs, src.path);
      const moves = rows.map((row) => ({ row, path: fits(movedPath(src.path, dst.path, row.path), 'path') }));
      // Only a move onto an ancestor can land one moved row on another; no provider moves a directory there.
      const sources = new Set(rows.map((r) => r.path));
      if (src.fs === dst.fs && moves.some((m) => sources.has(m.path))) throw new InvalidArgument(`cannot move ${src.fs}:${src.path} onto ${dst.path}, which holds it`, 'to');
      const taken = new Set(moves.map((m) => rowKey(m.path, m.row)));
      await deleteIds(
        tx,
        (await tree(tx, dst.fs, dst.path)).filter((r) => taken.has(rowKey(r.path, r))).map((r) => r.id),
      );
      for (const m of moves) await tx.update().in(FS_ACL_TABLE).update({ fs: dst.fs, path: m.path, path_hash: aclPathHash(m.path) }).where({ id: m.row.id });
    });
  }

  async movePath(fromFs: string, from: string, toFs: string, to: string): Promise<void> {
    const src = { fs: aclFs(fromFs), path: aclPath(from) };
    const dst = { fs: aclFs(toFs), path: aclPath(to) };
    if (src.fs === dst.fs && src.path === dst.path) return;
    const driver = await this.driver();
    await driver.transaction(async (tx) => {
      // The destination's equal rows go first, else the UPDATE would break the unique key.
      const moving = new Set((await exactRows(tx, src.fs, src.path)).map((r) => rowKey(dst.path, r)));
      await deleteIds(
        tx,
        (await exactRows(tx, dst.fs, dst.path)).filter((r) => moving.has(rowKey(r.path, r))).map((r) => r.id),
      );
      await tx.update().in(FS_ACL_TABLE).update({ fs: dst.fs, path: dst.path, path_hash: aclPathHash(dst.path) }).where({ fs: src.fs, path_hash: aclPathHash(src.path), path: src.path });
    });
  }

  private async driver(): Promise<OrmDriver> {
    const container = this.opts.container ?? DI.RootContainer;
    const name = this.opts.connection ?? fsAclConfig(container).connection;
    const orm = (await container.resolve(Orm)) as Orm;
    const driver = orm.Connections.get(name);
    if (!driver) throw new AuthzConfigError(`OrmFileAclStore: ${FS_ACL_CONNECTION_KEY} names connection ${JSON.stringify(name)}, which the ORM does not have (connections: ${[...orm.Connections.keys()].join(', ') || 'none'})`);
    return driver;
  }
}

const rowKey = (path: string, r: Row): string => `${path}\0${r.subject_key}\0${r.relation}`;

function live(row: Row, at: Date): boolean {
  const until = toDate(row.expires_at);
  return until === null || until.getTime() > at.getTime();
}

const oldestFirst = (rows: readonly Row[]): Row[] => [...rows].sort((a, b) => (toDate(a.created_at)?.getTime() ?? 0) - (toDate(b.created_at)?.getTime() ?? 0));

function rowOf(row: Row): FsAclRow {
  const expiresAt = toDate(row.expires_at);
  return Object.freeze({
    fs: row.fs,
    path: row.path,
    subject: subjectOfKey(row.subject_key, `${FS_ACL_TABLE} row ${row.id}`),
    relation: row.relation,
    ...(expiresAt ? { expiresAt } : {}),
    ...(row.granted_by ? { grantedBy: row.granted_by } : {}),
  });
}

async function exactRows(driver: OrmDriver, fs: string, path: string): Promise<Row[]> {
  const rows = ((await driver.select().from(FS_ACL_TABLE).where({ fs, path_hash: aclPathHash(path), path })) ?? []) as Row[];
  return rows.filter((r) => r.fs === fs && r.path === path);
}

/**
 * The rows at `path` and under it ('' = every row of the filesystem). LIKE with the wildcards escaped only narrows
 * the read (it ignores case under many collations); the exact test in code decides.
 */
async function tree(driver: OrmDriver, fs: string, path: string): Promise<Row[]> {
  if (path === '') return (((await driver.select().from(FS_ACL_TABLE).where({ fs })) ?? []) as Row[]).filter((r) => r.fs === fs);
  // MSSQL reads '[' as the start of a character class; escaped, it is a literal on every driver.
  const prefix = escapeLikeValue(path).replace(/\[/g, `${LIKE_ESCAPE_CHARACTER}[`);
  const below = ((await driver
    .select()
    .from(FS_ACL_TABLE)
    .where({ fs })
    .where(RawQuery.create(`path LIKE ? ESCAPE '${LIKE_ESCAPE_CHARACTER}'`, [`${prefix}/%`]))) ?? []) as Row[];
  return [...(await exactRows(driver, fs, path)), ...below.filter((r) => r.fs === fs && r.path.startsWith(`${path}/`))];
}

async function deleteIds(driver: OrmDriver, ids: readonly string[]): Promise<void> {
  for (const part of chunk(ids, IN_CHUNK)) await driver.del().from(FS_ACL_TABLE).whereIn('id', part);
}
