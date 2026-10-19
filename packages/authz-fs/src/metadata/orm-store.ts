import { AuthzConfigError } from '@spinajs/authz';
import { Injectable } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { OrmConnectionMissing, deleteFrom, modelDriver, ormReady } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { DateTime } from 'luxon';

import { FileMetadataStore } from '../api.js';
import type { FileMeta } from '../api.js';
import { normalizeFsPath } from '../refs/index.js';
import { FS_METADATA_CONNECTION } from './connection.js';
import { checkFileMeta, checkFsName } from './meta.js';
import { FS_OBJECT_TABLE, FsObjectRecord } from './record.js';
import type { FsObjectFields } from './record.js';

const LIMITS = { fs: 64, path: 512, owner_type: 32, owner_id: 64, scope_type: 64, scope_id: 64 } as const;

type MetaColumns = Pick<FsObjectFields, 'owner_type' | 'owner_id' | 'scope_type' | 'scope_id' | 'tags'>;

/**
 * FileMeta in table fs_object (migration AuthzFsObject_2026_10_01_00_00_00), one row per (fs, normalised path), on the
 * ORM connection alias `authz-fs`. `delete` removes the row of that path only; `deleteTree` and `move` take the rows
 * under a directory path along (providers remove and move directories whole).
 * Rows are matched exactly in code and changed by their stored key, whatever the column collation: a filesystem name
 * may end in a blank, which some binary collations ignore, and a table not created by the migration may ignore case.
 * On such a key a variant of an existing key is refused (the insert fails) instead of sharing its row.
 */
@Injectable(FileMetadataStore)
export class OrmFileMetadataStore extends FileMetadataStore {
  async get(fsName: string, path: string): Promise<FileMeta | null> {
    const fs = checkFsName(fsName);
    const p = normalizeFsPath(path);
    if (p === '') return null;
    await this.driver();
    const row = await exactRow(fs, p);
    return row ? metaOf(row) : null;
  }

  async set(fsName: string, path: string, meta: FileMeta): Promise<void> {
    const key = keyOf(fsName, path);
    const values = columnsOf(checkFileMeta(meta));
    await (await this.driver()).transaction(async () => {
      const now = DateTime.now();
      const row = await exactRow(key.fs, key.path);
      if (row) await FsObjectRecord.update({ ...values, updated_at: now }).where({ fs: row.fs, path: row.path });
      else await FsObjectRecord.insert({ ...key, ...values, created_at: now, updated_at: now });
    });
  }

  /** The checks `set` makes, without IO: the guard calls it before the IO, so a value that cannot be stored stops the write. */
  checkMeta(fsName: string, path: string, meta: FileMeta): void {
    keyOf(fsName, path);
    columnsOf(checkFileMeta(meta));
  }

  async move(fromFs: string, from: string, toFs: string, to: string): Promise<void> {
    const src = keyOf(fromFs, from);
    const dst = keyOf(toFs, to);
    if (src.fs === dst.fs && src.path === dst.path) return;
    if (src.fs === dst.fs && dst.path.startsWith(`${src.path}/`)) throw new InvalidArgument(`cannot move ${src.fs}:${src.path} into itself (${dst.path})`, 'to');
    await (await this.driver()).transaction(async () => {
      const rows = await tree(src.fs, src.path);
      const moves = rows.map((r) => ({ row: r, to: dst.path + r.path.slice(src.path.length) }));
      for (const m of moves) if (m.to.length > LIMITS.path) throw new InvalidArgument(`${dst.fs}:${m.to} does not fit ${FS_OBJECT_TABLE}.path (${LIMITS.path} characters)`, 'to');
      // Only a move onto an ancestor can land one moved row on another; no provider moves a directory there.
      const sources = new Set(rows.map((r) => r.path));
      if (src.fs === dst.fs && moves.some((m) => sources.has(m.to))) throw new InvalidArgument(`cannot move ${src.fs}:${src.path} onto ${dst.path}, which holds it`, 'to');
      const targets = new Set([dst.path, ...moves.map((m) => m.to)]);
      await deleteRows((await tree(dst.fs, dst.path)).filter((r) => targets.has(r.path)));
      const now = DateTime.now();
      for (const m of moves) await FsObjectRecord.update({ fs: dst.fs, path: m.to, updated_at: now }).where({ fs: m.row.fs, path: m.row.path });
    });
  }

  async delete(fsName: string, path: string): Promise<void> {
    const fs = checkFsName(fsName);
    const p = normalizeFsPath(path);
    if (p === '') return;
    await (await this.driver()).transaction(async () => {
      const row = await exactRow(fs, p);
      if (row) await deleteRows([row]);
    });
  }

  /** The row of `path` and every row under it ('' = every row of the filesystem). */
  async deleteTree(fsName: string, path: string): Promise<void> {
    const fs = checkFsName(fsName);
    const p = normalizeFsPath(path);
    await (await this.driver()).transaction(async () => deleteRows(await tree(fs, p)));
  }

  /** fs_object's driver, after resolving the Orm when nothing did yet: the record's statics exist only then. */
  private async driver(): Promise<OrmDriver> {
    await ormReady();
    try {
      return modelDriver(FsObjectRecord);
    } catch (err) {
      if (err instanceof OrmConnectionMissing) throw new AuthzConfigError(`OrmFileMetadataStore: no ORM connection answers to "${FS_METADATA_CONNECTION}"; set db.Aliases['${FS_METADATA_CONNECTION}']`, { cause: err });
      throw err;
    }
  }
}

/** The rows `query` reads; a `tags` value that is not JSON fails the read as a configuration error. */
async function read(query: PromiseLike<FsObjectRecord[]>): Promise<FsObjectRecord[]> {
  try {
    return await query;
  } catch (e) {
    if (e instanceof SyntaxError) throw new AuthzConfigError(`${FS_OBJECT_TABLE}: a row's tags is not JSON (${e.message})`, { cause: e });
    throw e;
  }
}

async function exactRow(fs: string, path: string): Promise<FsObjectRecord | undefined> {
  return (await read(FsObjectRecord.query().where({ fs, path }))).find((r) => r.fs === fs && r.path === path);
}

/** The row of `path` and the rows under it ('' = every row of the filesystem); the exact test in code decides. */
async function tree(fs: string, path: string): Promise<FsObjectRecord[]> {
  if (path === '') return (await read(FsObjectRecord.query().where({ fs }))).filter((r) => r.fs === fs);
  const row = await exactRow(fs, path);
  const below = await read(FsObjectRecord.query().where({ fs }).whereStartsWith('path', `${path}/`));
  return [...(row ? [row] : []), ...below.filter((r) => r.fs === fs && r.path.startsWith(`${path}/`))];
}

/** By the keys the rows hold: under a key that ignores case or trailing blanks no other row can equal them. */
async function deleteRows(rows: readonly FsObjectFields[]): Promise<void> {
  const byFs = new Map<string, string[]>();
  for (const r of rows) byFs.set(r.fs, [...(byFs.get(r.fs) ?? []), r.path]);
  for (const [fs, paths] of byFs) await deleteFrom(FsObjectRecord).where({ fs }).whereIn('path', paths);
}

function keyOf(fsName: string, path: string): { fs: string; path: string } {
  const fs = checkFsName(fsName);
  const p = normalizeFsPath(path);
  if (p === '') throw new InvalidArgument(`${fs}: the filesystem root has no metadata`, 'path');
  fits(fs, 'fs');
  fits(p, 'path');
  return { fs, path: p };
}

function fits(value: string, column: keyof typeof LIMITS): void {
  if (value.length > LIMITS[column]) throw new InvalidArgument(`${JSON.stringify(value.slice(0, 40))}… does not fit ${FS_OBJECT_TABLE}.${column} (${LIMITS[column]} characters)`, column);
}

function columnsOf(meta: FileMeta): MetaColumns {
  const row = {
    owner_type: meta.owner?.type ?? null,
    owner_id: meta.owner?.id ?? null,
    scope_type: meta.scope?.type ?? null,
    scope_id: meta.scope?.id ?? null,
    tags: meta.tags ?? null,
  };
  for (const column of ['owner_type', 'owner_id', 'scope_type', 'scope_id'] as const) {
    const value = row[column];
    if (value !== null) fits(value, column);
  }
  return row;
}

function metaOf(row: FsObjectFields): FileMeta {
  const meta: { owner?: unknown; scope?: unknown; tags?: unknown } = {};
  if (row.owner_type != null && row.owner_id != null) meta.owner = { type: row.owner_type, id: row.owner_id };
  if (row.scope_type != null) meta.scope = row.scope_id == null ? { type: row.scope_type } : { type: row.scope_type, id: row.scope_id };
  if (row.tags != null) meta.tags = row.tags;
  try {
    return checkFileMeta(meta, `${FS_OBJECT_TABLE} row ${row.fs}:${row.path}`);
  } catch (e) {
    throw new AuthzConfigError((e as Error).message, { cause: e });
  }
}
