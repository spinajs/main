import { InvalidArgument } from '@spinajs/exceptions';
import type { TenantRecord, TenantRunFailure, TenantRunReport, TenantState } from './contracts.js';
import { TenantSwitchDenied } from './errors.js';
import { runInTenant, tenantScope } from './scope.js';
import { tenantRegistry } from './services.js';

export interface ForEachTenantOptions {
  /** Tenants handled at once; default 1. */
  concurrency?: number;
  /** Default `['active']`. */
  states?: TenantState[];
}

/**
 * Runs `fn` once per tenant of the registry, each inside `runInTenant`, and reports the tenants whose `fn` rejected
 * instead of stopping at the first. Callable with no scope and from the cross-tenant scope.
 *
 * @throws TenantSwitchDenied inside a single-tenant scope
 */
export async function forEachTenant(fn: (tenant: TenantRecord) => Promise<void>, options: ForEachTenantOptions = {}): Promise<TenantRunReport> {
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new InvalidArgument('forEachTenant: concurrency must be a positive integer', 'concurrency');
  }
  const scope = tenantScope();
  if (scope?.kind === 'tenant') {
    throw new TenantSwitchDenied(`forEachTenant cannot run inside tenant "${scope.tenant.id}"; leave the scope with runAcrossTenants(reason) first`);
  }

  const states = options.states ?? ['active'];
  const registry = await tenantRegistry();
  const tenants = registry.list({ states })[Symbol.asyncIterator]();
  const failed: TenantRunFailure[] = [];
  let total = 0;

  // One pull at a time: an iterator of a registry need not queue concurrent next() calls.
  let turn: Promise<unknown> = Promise.resolve();
  const pull = (): Promise<IteratorResult<TenantRecord>> => {
    const result = turn.then(() => tenants.next());
    turn = result.catch(() => undefined);
    return result;
  };

  const worker = async (): Promise<void> => {
    for (let next = await pull(); !next.done; next = await pull()) {
      const tenant = next.value;
      // A registry that ignores the filter must not get a suspended or deleted tenant visited.
      if (!states.includes(tenant.state)) continue;
      total += 1;
      try {
        await runInTenant(tenant.id, () => fn(tenant));
      } catch (error) {
        failed.push({ tenant: tenant.id, error });
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { total, succeeded: total - failed.length, failed };
}
