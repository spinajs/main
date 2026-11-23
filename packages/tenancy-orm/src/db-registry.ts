import { Injectable } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { TenantRegistry, isTenantId } from '@spinajs/tenancy';
import type { TenantRecord, TenantState } from '@spinajs/tenancy';

import { TenantModel } from './models/TenantModel.js';
import { toTenantRecord } from './records.js';

// Lower-case host names only: such a value holds neither the delimiter of a @Set() column nor a wildcard.
const DOMAIN = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

/** The tenant table as the tenant registry: `tenancy.registry: 'DbTenantRegistry'`. */
@Injectable(TenantRegistry)
export class DbTenantRegistry extends TenantRegistry {
  protected pageSize = 200;

  /** A value that is not a tenant id finds nothing: MySQL and MSSQL would match `t1 ` to `t1`. */
  public async get(id: string): Promise<TenantRecord | undefined> {
    if (!isTenantId(id)) return undefined;
    const row = await TenantModel.where('id', id).first();
    return row ? toTenantRecord(row) : undefined;
  }

  /** By slug when one is given, else by domain; both are compared for equality, never as a pattern. */
  public async find(by: { slug?: string; domain?: string }): Promise<TenantRecord | undefined> {
    if (by.slug !== undefined) {
      const row = await TenantModel.where('slug', by.slug).first();
      return row ? toTenantRecord(row) : undefined;
    }
    return by.domain === undefined ? undefined : this.byDomain(by.domain.trim().toLowerCase());
  }

  public async *list(filter?: { states?: TenantState[] }): AsyncIterable<TenantRecord> {
    const states = filter?.states;
    let after = '';
    // spinajs-orm-ignore ORM102: deliberate paging, one query per pageSize tenants
    for (;;) {
      const page = TenantModel.where('id', '>', after).orderBy('id').take(this.pageSize);
      if (states !== undefined) page.whereIn('state', states);
      const rows = await page;
      for (const row of rows) yield toTenantRecord(row);
      const last = rows.at(-1);
      if (last === undefined || rows.length < this.pageSize) return;
      after = last.id;
    }
  }

  protected async byDomain(domain: string): Promise<TenantRecord | undefined> {
    if (!DOMAIN.test(domain)) return undefined;
    const [first, second] = await TenantModel.query().whereInSet('domains', [domain]).orderBy('id').take(2);
    // The table cannot make a domain unique, so a duplicate is refused here instead of picking a tenant.
    if (second !== undefined) throw new InvalidOperation(`tenancy-orm: domain "${domain}" is listed by tenants "${first.id}" and "${second.id}"; a domain belongs to one tenant`);
    return first === undefined ? undefined : toTenantRecord(first);
  }
}
