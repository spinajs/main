import { AsyncLocalStorage } from 'node:async_hooks';
import { DI } from '@spinajs/di';
import { SHARED_SCOPE } from '@spinajs/configuration-db-source';
import { ConfigScopeRefused } from './errors.js';

const field = (value: unknown, key: string): unknown => (value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined);

/** The configuration api serves the shared rows, and only to a request outside any tenant scope. */
export function requestScope(): string {
  const store: unknown = DI.resolve(AsyncLocalStorage).getStore();
  if (field(store, 'Tenant') === undefined) return SHARED_SCOPE;
  throw new ConfigScopeRefused('the configuration api serves the shared rows outside any tenant scope; a tenant changes its overrides through its settings (TenantSettingsService)');
}
