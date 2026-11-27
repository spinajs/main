import { Injectable, Singleton } from '@spinajs/di';
import { ScopedConfigurationSource } from '@spinajs/configuration-common';
import { InternalLogger } from '@spinajs/internal-logger';

import { DbConfig } from './models/DbConfig.js';
import { asSystem } from './system.js';

// Not '': the ORM refuses a model write while a required column holds ''. No tenant scope (`tenant:<id>`) equals it.
export const SHARED_SCOPE = 'shared';

const DEFAULT_TTL_MS = 60_000;

// @spinajs/tenancy's id pattern, copied: this package does not depend on tenancy.
const TENANT_SCOPE = /^tenant:[a-z0-9_-]{1,64}$/;

export interface ScopedConfigurationRow {
  readonly scope: string;
  readonly slug: string;
  readonly value: unknown;
}

/** A row of one scope; a row read before the Scope column existed has none and is shared. */
export function isScopedEntry<T extends { Scope?: unknown }>(entry: T): entry is T & { Scope: string } {
  return typeof entry.Scope === 'string' && entry.Scope !== SHARED_SCOPE;
}

/**
 * The rows whose `Scope` is exactly `shared`, `tenant:<id>` or absent (read before the column existed); any other is
 * dropped with a warning. MySQL compares the column without case, so `TENANT:ACME` would answer `tenant:acme` there.
 */
export function wellScoped<T extends { Slug: string; Scope?: unknown }>(rows: readonly T[]): T[] {
  return rows.filter((row) => {
    if (row.Scope === undefined || row.Scope === null || row.Scope === SHARED_SCOPE || (typeof row.Scope === 'string' && TENANT_SCOPE.test(row.Scope))) return true;
    InternalLogger.warn({ scope: row.Scope, slug: row.Slug }, 'Configuration row ${slug} has the scope ${scope}, which is neither shared nor tenant:<id>; it is ignored', 'configuration-db-source');
    return false;
  });
}

/**
 * The exposed rows of the configuration table that belong to one scope, by scope and slug. The source fills it when the
 * configuration loads. A read of rows older than `ttlMs` answers what it holds and starts one background read; after
 * `dispose()` no read starts, and one in flight applies nothing.
 */
@Singleton()
@Injectable(ScopedConfigurationSource)
export class ScopedDbConfiguration extends ScopedConfigurationSource {
  public ttlMs = DEFAULT_TTL_MS;

  private byScope = new Map<string, ReadonlyMap<string, unknown>>();

  private loadedAt = 0;

  private reading: Promise<void> | undefined;

  private disposed = false;

  public valuesOf(scope: string): ReadonlyMap<string, unknown> | undefined {
    if (this.ttlMs > 0 && Date.now() - this.loadedAt >= this.ttlMs) void this.refresh();
    return this.byScope.get(scope);
  }

  public replace(rows: readonly ScopedConfigurationRow[]): void {
    const byScope = new Map<string, Map<string, unknown>>();
    for (const row of rows) {
      let values = byScope.get(row.scope);
      if (values === undefined) {
        values = new Map();
        byScope.set(row.scope, values);
      }
      values.set(row.slug, row.value);
    }
    this.byScope = byScope;
    this.loadedAt = Date.now();
  }

  /** Reads the scoped rows again; a read already running is shared. Never rejects: a failed read keeps the rows held. */
  public refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    // Stamped when the read starts, so reads while it runs or after it failed wait one ttl before the next.
    this.loadedAt = Date.now();
    this.reading ??= this.readAgain().finally(() => {
      this.reading = undefined;
    });
    return this.reading;
  }

  public override async dispose(): Promise<void> {
    this.disposed = true;
    await this.reading;
  }

  private async readAgain(): Promise<void> {
    try {
      const rows = await this.read();
      if (!this.disposed) this.replace(rows);
    } catch (error) {
      InternalLogger.warn({ error }, 'Failed to read the scoped configuration rows again; the rows held stay', 'configuration-db-source');
    }
  }

  protected async read(): Promise<ScopedConfigurationRow[]> {
    const rows = await asSystem(() => DbConfig.where('Scope', '!=', SHARED_SCOPE).where('Exposed', true));
    return wellScoped(rows).map((row) => ({ scope: row.Scope, slug: row.Slug, value: row.Value }));
  }
}
