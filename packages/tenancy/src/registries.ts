import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidArgument, InvalidOption } from '@spinajs/exceptions';
import { TENANT_STATES, TenantRegistry } from './contracts.js';
import type { TenantPlacement, TenantRecord, TenantRef, TenantState } from './contracts.js';
import { tenantRef } from './scope.js';

/** A complete, frozen record: the slug and the name default to the id, the state to 'active'; domains are lower-cased. */
export function tenantRecord(input: Partial<TenantRecord> & TenantRef): TenantRecord {
  const { id } = tenantRef(input);
  const record: TenantRecord = {
    id,
    slug: input.slug ?? id,
    name: input.name ?? id,
    state: input.state ?? 'active',
    domains: Object.freeze((input.domains ?? []).map((domain) => domain.toLowerCase())),
    ...(input.placement ? { placement: Object.freeze({ ...input.placement }) } : {}),
    settings: Object.freeze({ ...(input.settings ?? {}) }),
  };
  return Object.freeze(record);
}

function matches(record: TenantRecord, by: { slug?: string; domain?: string }): boolean {
  if (by.slug === undefined && by.domain === undefined) return false;
  if (by.slug !== undefined && record.slug !== by.slug) return false;
  return by.domain === undefined || record.domains.includes(by.domain.toLowerCase());
}

function iterate<T>(items: readonly T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<T> => {
      let index = 0;
      return {
        next: (): Promise<IteratorResult<T>> => {
          const result: IteratorResult<T> = index < items.length ? { done: false, value: items[index++] } : { done: true, value: undefined };
          return Promise.resolve(result);
        },
      };
    },
  };
}

/** A registry that holds every tenant in memory, so it needs no cache in front of it. */
export abstract class ListedTenantRegistry extends TenantRegistry {
  public override get cacheable(): boolean {
    return false;
  }

  protected abstract records(): readonly TenantRecord[];

  public get(id: string): Promise<TenantRecord | undefined> {
    return Promise.resolve(this.records().find((record) => record.id === id));
  }

  public find(by: { slug?: string; domain?: string }): Promise<TenantRecord | undefined> {
    return Promise.resolve(this.records().find((record) => matches(record, by)));
  }

  public list(filter?: { states?: TenantState[] }): AsyncIterable<TenantRecord> {
    const states = filter?.states;
    return iterate(states ? this.records().filter((record) => states.includes(record.state)) : this.records());
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

const textOf = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

const stateOf = (value: unknown): TenantState | undefined => TENANT_STATES.find((state) => state === value);

const textsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item: unknown): item is string => typeof item === 'string') : []);

function placementOf(value: unknown): TenantPlacement | undefined {
  return isObject(value) && value.kind === 'schema' && typeof value.schema === 'string' ? { kind: 'schema', schema: value.schema } : undefined;
}

// The configuration schema checks the shape at boot; this narrows what it let through, entry by entry.
function listedTenant(entry: unknown, index: number): TenantRecord {
  if (!isObject(entry) || typeof entry.id !== 'string') {
    throw new InvalidOption(`tenancy.tenants[${index}] needs an id`);
  }
  return tenantRecord({
    id: entry.id,
    slug: textOf(entry.slug),
    name: textOf(entry.name),
    state: stateOf(entry.state),
    domains: textsOf(entry.domains),
    placement: placementOf(entry.placement),
    settings: isObject(entry.settings) ? entry.settings : undefined,
  });
}

/** The tenants listed under `tenancy.tenants`, parsed again whenever the configured list is replaced. */
@Injectable(TenantRegistry)
export class ConfigTenantRegistry extends ListedTenantRegistry {
  @Config('tenancy.tenants', { defaultValue: [] })
  protected Listed: unknown;

  private parsedFrom: unknown;

  private parsed: readonly TenantRecord[] = [];

  protected records(): readonly TenantRecord[] {
    const listed = this.Listed;
    if (listed !== this.parsedFrom) {
      this.parsed = Array.isArray(listed) ? listed.map((entry: unknown, index) => listedTenant(entry, index)) : [];
      this.parsedFrom = listed;
    }
    return this.parsed;
  }
}

/** Tenants kept in the process: tests and single-process setups. */
@Injectable(TenantRegistry)
export class MemoryTenantRegistry extends ListedTenantRegistry {
  private readonly byId = new Map<string, TenantRecord>();

  protected records(): readonly TenantRecord[] {
    return [...this.byId.values()];
  }

  public add(record: Partial<TenantRecord> & TenantRef): TenantRecord {
    const added = tenantRecord(record);
    this.byId.set(added.id, added);
    return added;
  }

  public set(id: string, patch: Partial<TenantRecord>): TenantRecord {
    const current = this.byId.get(id);
    if (!current) {
      throw new InvalidArgument(`MemoryTenantRegistry has no tenant "${id}"`, 'id');
    }
    return this.add({ ...current, ...patch, id });
  }
}
