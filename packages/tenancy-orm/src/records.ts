import { InvalidOperation } from '@spinajs/exceptions';
import type { TenantPlacement, TenantRecord } from '@spinajs/tenancy';

import type { TenantModel } from './models/TenantModel.js';
import { isTenantState } from './state-machine.js';

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function placementOf(value: unknown): TenantPlacement | undefined {
  if (!isRecord(value) || value.kind !== 'schema') return undefined;
  const schema: unknown = value.schema;
  if (typeof schema !== 'string' || schema === '') return undefined;
  const placement: TenantPlacement = { kind: 'schema', schema };
  return Object.freeze(placement);
}

function domainsOf(value: unknown): string[] {
  const list: unknown[] = Array.isArray(value) ? value : [];
  return list.filter((domain): domain is string => typeof domain === 'string' && domain !== '');
}

/** A row of the tenant table as the registry hands it out. A state the machine does not know is refused, not passed on. */
export function toTenantRecord(row: TenantModel): TenantRecord {
  const state: unknown = row.state;
  if (!isTenantState(state)) throw new InvalidOperation(`tenancy-orm: tenant "${row.id}" has the unknown state ${JSON.stringify(state)}`);
  const placement = placementOf(row.placement);
  return Object.freeze({
    id: row.id,
    slug: row.slug,
    name: row.name,
    state,
    domains: Object.freeze(domainsOf(row.domains)),
    ...(placement === undefined ? {} : { placement }),
    settings: Object.freeze({ ...(isRecord(row.settings) ? row.settings : {}) }),
  });
}
