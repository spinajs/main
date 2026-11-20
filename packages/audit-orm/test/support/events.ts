import type { AuditEvent } from '@spinajs/audit';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { OrmDriver } from '@spinajs/orm';

import { rowsOf } from '../../src/index.js';
import type { AuditRow } from '../../src/index.js';

export const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

/** Event `n` of contract `c<n>`, on a whole second so every dialect stores `at` exactly. */
export function event(n: number, extra: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    at: new Date(Date.UTC(2026, 10, 16, 10, 0, n)),
    kind: 'custom',
    action: 'contract.signed',
    subject: { type: 'contract', id: `c${n}` },
    outcome: 'ok',
    actor: 'user:u1',
    traceId: TRACE,
    data: { version: n },
    ...extra,
  };
}

export function config(): Configuration {
  const found = DI.get(Configuration);
  if (!found) throw new Error('the test application has no Configuration');
  return found;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Sets or, with `undefined`, removes one trail. It writes the whole map: a key left with the value undefined would fail the trail schema. */
export function setTrail(name: string, options: Record<string, unknown> | undefined): void {
  const trails = config().get<unknown>(['audit', 'trails']);
  const rest = Object.fromEntries(Object.entries(isRecord(trails) ? trails : {}).filter(([key]) => key !== name));
  config().set(['audit', 'trails'], options === undefined ? rest : { ...rest, [name]: options });
}

/** Every row of a table, ordered by one column. */
export async function tableRows(driver: OrmDriver, table: string, orderBy = 'seq'): Promise<AuditRow[]> {
  return rowsOf(await driver.select().from(table).orderBy(orderBy));
}
