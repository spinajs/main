import type { OrmDriver } from '@spinajs/orm';

import { AUTHZ_RESOURCE_ANCESTOR_TABLE, AuthzResourceAncestor_2026_10_14_00_00_00 } from '../../src/ancestors/index.js';
import type { AncestorRow } from '../../src/ancestors/index.js';
import type { Dialect, TestDb } from './db.js';

export async function createAncestorTable(db: TestDb, dialect: Dialect): Promise<void> {
  await db.raw(`DROP TABLE IF EXISTS "${AUTHZ_RESOURCE_ANCESTOR_TABLE}"`, [], dialect);
  await new AuthzResourceAncestor_2026_10_14_00_00_00().up(db.driver(dialect));
}

export async function dropAncestorTable(db: TestDb, dialect: Dialect): Promise<void> {
  await db.raw(`DROP TABLE IF EXISTS "${AUTHZ_RESOURCE_ANCESTOR_TABLE}"`, [], dialect);
}

/** `type:id>type:id@depth`, sorted: easy to compare in a deep equal. */
export async function ancestorLinks(driver: OrmDriver): Promise<string[]> {
  const rows = (await driver.select().from(AUTHZ_RESOURCE_ANCESTOR_TABLE)) as AncestorRow[];
  return rows.map((r) => `${r.resource_type}:${r.resource_id}>${r.ancestor_type}:${r.ancestor_id}@${Number(r.depth)}`).sort();
}

export async function insertLinks(driver: OrmDriver, links: readonly string[]): Promise<void> {
  if (links.length === 0) return;
  const rows = links.map((l) => {
    const m = /^([^:]+):([^>]+)>([^:]+):([^@]+)@(\d+)$/.exec(l);
    if (!m) throw new Error(`bad link ${l}`);
    return { resource_type: m[1], resource_id: m[2], ancestor_type: m[3], ancestor_id: m[4], depth: Number(m[5]) };
  });
  await driver.insert().into(AUTHZ_RESOURCE_ANCESTOR_TABLE).values(rows);
}
