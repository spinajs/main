import { AsyncService, Autoinject, Container, DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config, resolveNamedService } from '@spinajs/configuration';
import type { Principal } from '@spinajs/principal';
import { CachedTenantRegistry } from './cache.js';
import { TenantAccess, TenantRegistry } from './contracts.js';
import type { TenantProposal, TenantRecord } from './contracts.js';
import { TenantUnavailable } from './errors.js';
import { TENANCY_DEFAULTS } from './schema.js';
import { isTenantId } from './scope.js';

/** The registry and the access check a container's configuration names; one instance per container. */
export class TenancyServices extends AsyncService {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Config('tenancy.registryCacheMs', { defaultValue: TENANCY_DEFAULTS.registryCacheMs })
  protected CacheMs!: number;

  public registry!: CachedTenantRegistry;

  public access!: TenantAccess;

  public async resolve(): Promise<void> {
    const inner = await resolveNamedService(this.Container, 'tenancy.registry', TenantRegistry, { default: TENANCY_DEFAULTS.registry });
    this.registry = new CachedTenantRegistry(inner, () => this.CacheMs);
    this.access = await resolveNamedService(this.Container, 'tenancy.access', TenantAccess, { default: TENANCY_DEFAULTS.access });
    await super.resolve();
  }
}

export async function tenantRegistry(container: IContainer = DI.RootContainer): Promise<CachedTenantRegistry> {
  return (await container.resolve(TenancyServices)).registry;
}

export async function tenantAccess(container: IContainer = DI.RootContainer): Promise<TenantAccess> {
  return (await container.resolve(TenancyServices)).access;
}

function lookup(registry: TenantRegistry, proposal: TenantProposal): Promise<TenantRecord | undefined> {
  if (typeof proposal === 'string') return isTenantId(proposal) ? registry.get(proposal) : Promise.resolve(undefined);
  return 'slug' in proposal ? registry.find({ slug: proposal.slug }) : registry.find({ domain: proposal.domain });
}

/**
 * The record of a proposed tenant, once the registry knows it, it is active and, for an authenticated principal,
 * `TenantAccess.canEnter` holds.
 *
 * @throws TenantUnavailable with the reason 'unknown', 'inactive' or 'forbidden'
 */
export async function admitTenant(proposal: TenantProposal, principal?: Principal, container: IContainer = DI.RootContainer): Promise<TenantRecord> {
  const services = await container.resolve(TenancyServices);
  const record = await lookup(services.registry, proposal);

  if (!record) throw new TenantUnavailable('unknown', 'no such tenant');
  if (record.state !== 'active') throw new TenantUnavailable('inactive', `tenant "${record.id}" is ${record.state}`);
  if (principal?.authenticated === true && !(await services.access.canEnter(principal, record))) {
    throw new TenantUnavailable('forbidden', `${principal.type}:${principal.id} may not enter tenant "${record.id}"`);
  }
  return record;
}
