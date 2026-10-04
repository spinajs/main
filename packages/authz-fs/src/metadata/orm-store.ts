import { AuthzConfigError } from '@spinajs/authz';
import { DI, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { LIKE_ESCAPE_CHARACTER, Orm, RawQuery, escapeLikeValue } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { FileMetadataStore } from '../api.js';
import type { FileMeta } from '../api.js';
import { normalizeFsPath } from '../refs/index.js';
import { FS_METADATA_CONNECTION_KEY, fsMetadataConnection } from './connection.js';
import { checkFileMeta, checkFsName } from './meta.js';

const TABLE = 'fs_object';
const LIMITS = { fs: 64, path: 512, owner_type: 32, owner_id: 64, scope_type: 64, scope_id: 64 } as const;
const IN_CHUNK = 500;

interface Row {
  readonly fs: string;
  readonly path: string;
  readonly owner_type: string | null;
  readonly owner_id: string | null;
  readonly scope_type: string | null;
  readonly scope_id: string | null;
  readonly tags: string | null;
}

export interface OrmFileMetadataStoreOptions {
  /** The ORM connection; default: config authz.fsMetadata.connection, else the ORM default connection. */
  readonly connection?: string;
  /** Where Configuration and Orm are resolved; default the DI root. */
  readonly container?: IContainer;
}

const chunks = <T>(list: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

/**
 * FileMeta in table fs_object (migration AuthzFsObject_2026_10_01_00_00_00), one row per (fs, normalised path).
 * `delete` and `move` take the rows under a directory path along: providers remove and move directories whole.
 * Paths are matched exactly in code and rows changed by their stored key, whatever the column collation: on a
 * case-insensitive one, a case variant of an existing path is refused (the insert fails) instead of sharing its row.
 */
@Injectable(FileMetadataStore)
export class OrmFileMetadataStore extends FileMetadataStore {
  constructor(private readonly opts: OrmFileMetadataStoreOptions = {}) {
    super();
  }

  async get(fsName: string, path: string): Promise<FileMeta | null> {
    const fs = checkFsName(fsName);
    const p = normalizeFsPath(path);
    if (p === '') return null;
    const row = await exactRow(await this.driver(), fs, p);
    return row ? metaOf(row) : null;
  }

  async set(fsName: string, path: string, meta: FileMeta): Promise<void> {
    const key = keyOf(fsName, path);
    const values = columnsOf(checkFileMeta(meta));
    const driver = await this.driver();
    await driver.transaction(async (tx) => {
      const now = new Date();
      const row = await exactRow(tx, key.fs, key.path);
      if (row)
        await tx
          .update()
          .in(TABLE)
          .update({ ...values, updated_at: now })
          .where({ fs: row.fs, path: row.path });
      else
        await tx
          .insert()
          .into(TABLE)
          .values({ ...key, ...values, created_at: now, updated_at: now });
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
    const driver = await this.driver();
    await driver.transaction(async (tx) => {
      const rows = await tree(tx, src.fs, src.path);
      const moves = rows.map((r) => ({ row: r, to: dst.path + r.path.slice(src.path.length) }));
      for (const m of moves) if (m.to.length > LIMITS.path) throw new InvalidArgument(`${dst.fs}:${m.to} does not fit ${TABLE}.path (${LIMITS.path} characters)`, 'to');
      // Only a move onto an ancestor can land one moved row on another; no provider moves a directory there.
      const sources = new Set(rows.map((r) => r.path));
      if (src.fs === dst.fs && moves.some((m) => sources.has(m.to))) throw new InvalidArgument(`cannot move ${src.fs}:${src.path} onto ${dst.path}, which holds it`, 'to');
      const targets = new Set([dst.path, ...moves.map((m) => m.to)]);
      await deleteRows(
        tx,
        (await tree(tx, dst.fs, dst.path)).filter((r) => targets.has(r.path)),
      );
      const now = new Date();
      for (const m of moves) await tx.update().in(TABLE).update({ fs: dst.fs, path: m.to, updated_at: now }).where({ fs: m.row.fs, path: m.row.path });
    });
  }

  async delete(fsName: string, path: string): Promise<void> {
    const fs = checkFsName(fsName);
    const p = normalizeFsPath(path);
    const driver = await this.driver();
    await driver.transaction(async (tx) => deleteRows(tx, await tree(tx, fs, p)));
  }

  private async driver(): Promise<OrmDriver> {
    const container = this.opts.container ?? DI.RootContainer;
    const name = this.opts.connection ?? fsMetadataConnection(container);
    const orm = (await container.resolve(Orm)) as Orm;
    const driver = orm.Connections.get(name);
    if (!driver) throw new AuthzConfigError(`OrmFileMetadataStore: ${FS_METADATA_CONNECTION_KEY} names connection ${JSON.stringify(name)}, which the ORM does not have (connections: ${[...orm.Connections.keys()].join(', ') || 'none'})`);
    return driver;
  }
}

async function exactRow(driver: OrmDriver, fs: string, path: string): Promise<Row | undefined> {
  const rows = ((await driver.select().from(TABLE).where({ fs, path })) ?? []) as Row[];
  return rows.find((r) => r.fs === fs && r.path === path);
}

/**
 * The row of `path` and the rows under it ('' = every row of the filesystem). LIKE with the wildcards escaped only
 * narrows the read (it ignores case under many collations); the exact test in code decides.
 */
async function tree(driver: OrmDriver, fs: string, path: string): Promise<Row[]> {
  if (path === '') return (((await driver.select().from(TABLE).where({ fs })) ?? []) as Row[]).filter((r) => r.fs === fs);
  const row = await exactRow(driver, fs, path);
  const below = ((await driver
    .select()
    .from(TABLE)
    .where({ fs })
    .where(RawQuery.create(`path LIKE ? ESCAPE '${LIKE_ESCAPE_CHARACTER}'`, [`${escapeLikeValue(path)}/%`]))) ?? []) as Row[];
  return [...(row ? [row] : []), ...below.filter((r) => r.fs === fs && r.path.startsWith(`${path}/`))];
}

/** By the keys the rows hold: under a case-insensitive key no other row can equal them. */
async function deleteRows(driver: OrmDriver, rows: readonly Row[]): Promise<void> {
  const byFs = new Map<string, string[]>();
  for (const r of rows) byFs.set(r.fs, [...(byFs.get(r.fs) ?? []), r.path]);
  for (const [fs, paths] of byFs) for (const part of chunks(paths, IN_CHUNK)) await driver.del().from(TABLE).where({ fs }).whereIn('path', part);
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
  if (value.length > LIMITS[column]) throw new InvalidArgument(`${JSON.stringify(value.slice(0, 40))}… does not fit ${TABLE}.${column} (${LIMITS[column]} characters)`, column);
}

function columnsOf(meta: FileMeta): Omit<Row, 'fs' | 'path'> {
  const row = {
    owner_type: meta.owner?.type ?? null,
    owner_id: meta.owner?.id ?? null,
    scope_type: meta.scope?.type ?? null,
    scope_id: meta.scope?.id ?? null,
    tags: meta.tags ? JSON.stringify(meta.tags) : null,
  };
  for (const column of ['owner_type', 'owner_id', 'scope_type', 'scope_id'] as const) {
    const value = row[column];
    if (value !== null) fits(value, column);
  }
  return row;
}

function metaOf(row: Row): FileMeta {
  const meta: { owner?: unknown; scope?: unknown; tags?: unknown } = {};
  if (row.owner_type !== null && row.owner_id !== null) meta.owner = { type: row.owner_type, id: row.owner_id };
  if (row.scope_type !== null) meta.scope = row.scope_id === null ? { type: row.scope_type } : { type: row.scope_type, id: row.scope_id };
  if (row.tags !== null) {
    try {
      meta.tags = JSON.parse(row.tags);
    } catch {
      throw new AuthzConfigError(`${TABLE} row ${row.fs}:${row.path}: tags is not JSON`);
    }
  }
  try {
    return checkFileMeta(meta, `${TABLE} row ${row.fs}:${row.path}`);
  } catch (e) {
    throw new AuthzConfigError((e as Error).message, { cause: e });
  }
}
