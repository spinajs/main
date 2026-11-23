import { InvalidOperation } from '@spinajs/exceptions';
import { isTenantId } from '@spinajs/tenancy';
import type { TenantPlacement, TenantRecord } from '@spinajs/tenancy';

import type { TenantModel } from './models/TenantModel.js';
import { isTenantState } from './state-machine.js';

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function shapeOf(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return 'an array';
  if (isRecord(value)) return typeof value.kind === 'string' ? `an object of kind ${JSON.stringify(value.kind)}` : 'an object';
  return `a ${typeof value}`;
}

// Names the shape, never the value: settings may hold a secret, a placement connection details.
const unreadable = (row: TenantModel, column: string, value: unknown): InvalidOperation => new InvalidOperation(`tenancy-orm: tenant "${row.id}" has unreadable ${column} (${shapeOf(value)})`);

// No placement means the default one, so a placement that cannot be read must not pass as none.
function placementOf(row: TenantModel): TenantPlacement | undefined {
  const value: unknown = row.placement;
  if (value === null || value === undefined) return undefined;
  const schema: unknown = isRecord(value) ? value.schema : undefined;
  if (!isRecord(value) || value.kind !== 'schema' || typeof schema !== 'string' || schema === '') throw unreadable(row, 'placement', value);
  const placement: TenantPlacement = { kind: 'schema', schema };
  return Object.freeze(placement);
}

function settingsOf(row: TenantModel): Record<string, unknown> {
  const value: unknown = row.settings;
  if (!isRecord(value)) throw unreadable(row, 'settings', value);
  return value;
}

function domainsOf(value: unknown): string[] {
  const list: unknown[] = Array.isArray(value) ? value : [];
  return list.filter((domain): domain is string => typeof domain === 'string' && domain !== '');
}

/** A row of the tenant table as the registry hands it out. A row it cannot read in full is refused, not passed on. */
export function toTenantRecord(row: TenantModel): TenantRecord {
  if (!isTenantId(row.id)) throw new InvalidOperation(`tenancy-orm: the tenant row ${JSON.stringify(row.id)} has an id that is not a tenant id`);
  const state: unknown = row.state;
  if (!isTenantState(state)) throw new InvalidOperation(`tenancy-orm: tenant "${row.id}" has the unknown state ${JSON.stringify(state)}`);
  const placement = placementOf(row);
  return Object.freeze({
    id: row.id,
    slug: row.slug,
    name: row.name,
    state,
    domains: Object.freeze(domainsOf(row.domains)),
    ...(placement === undefined ? {} : { placement }),
    settings: Object.freeze({ ...settingsOf(row) }),
  });
}
