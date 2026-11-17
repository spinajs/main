import { instantFromDb } from '@spinajs/orm';
import type { OrmDriver, SelectQueryBuilder } from '@spinajs/orm';

import { rowsOf } from '../rows.js';
import type { AuditRow } from '../rows.js';
import { AUDIT_SEAL_TABLE } from './table.js';

export interface AuditSeal {
  readonly id: number;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly count: number;
  readonly hash: string;
  readonly previousHash: string | null;
  readonly sealedAt: Date;
  readonly pruned: boolean;
}

export const SEAL_PAGE_SIZE = 200;

const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** The `data_hash` a row of a trail table carries; undefined for a row stored without one. */
export function storedHash(row: AuditRow): string | undefined {
  return text(row.data_hash);
}

function toSeal(row: AuditRow): AuditSeal {
  return {
    id: Number(row.id),
    fromSeq: Number(row.from_seq),
    toSeq: Number(row.to_seq),
    count: Number(row.event_count),
    hash: text(row.hash) ?? '',
    previousHash: text(row.previous_hash) ?? null,
    // Compared in JavaScript, never in SQL; an unreadable time is an invalid date, which retention treats as too young.
    sealedAt: instantFromDb(row.sealed_at)?.toJSDate() ?? new Date(Number.NaN),
    pruned: row.pruned_at !== null && row.pruned_at !== undefined,
  };
}

/** One page of the seals of a table after `toSeq`, in chain order. */
export async function sealsAfter(driver: OrmDriver, table: string, toSeq: number, options: { readonly unprunedOnly?: boolean } = {}): Promise<AuditSeal[]> {
  const select: SelectQueryBuilder<unknown> = driver.select().from(AUDIT_SEAL_TABLE).where('trail_table', table).where('to_seq', '>', toSeq);
  if (options.unprunedOnly === true) select.whereNull('pruned_at');
  return rowsOf(await select.orderBy('to_seq').take(SEAL_PAGE_SIZE)).map(toSeal);
}

export async function lastSeal(driver: OrmDriver, table: string): Promise<AuditSeal | undefined> {
  const rows = rowsOf(await driver.select().from(AUDIT_SEAL_TABLE).where('trail_table', table).orderByDescending('to_seq').take(1));
  return rows.map(toSeal)[0];
}
