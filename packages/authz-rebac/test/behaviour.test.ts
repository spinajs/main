import 'mocha';
import { AccessDenied, Authorizer, DefaultConditionCompiler, LruDecisionCache, validateBoot } from '@spinajs/authz';
import type { AuthorizationModel, AuthorizerOptions, CheckInput, Decision, NativeFilter, Permission, Principal, RequestScope, ResourceRef, ResourceType } from '@spinajs/authz';
import { fakeModelInitContext, instantiateWorld, runBehaviour } from '@spinajs/authz-testing';
import type { BehaviourAuthz, BehaviourHarness, BehaviourSelector } from '@spinajs/authz-testing';

import { MemoryTupleStore, RebacModel } from '../src/index.js';

const DOMAIN = 'root';

/** The B-rules this package owns. */
export const REBAC_PARTS: readonly BehaviourSelector[] = ['B49'];

function engineAuthz(authorizer: Authorizer): BehaviourAuthz {
  const scope = (): RequestScope => ({ cache: new Map() });
  const input = (principal: Principal, permission: Permission, resource?: ResourceRef | object, subject?: unknown): CheckInput => ({ principal, permission, ...(resource !== undefined ? { resource } : {}), ...(subject !== undefined ? { subject } : {}) });
  const check = (req: CheckInput): Promise<Decision> => authorizer.check(req, scope());
  return {
    check,
    explain: (req) => authorizer.explain(req, scope()),
    checkMany: (principal, permissions, resource) => authorizer.checkMany(principal, permissions, resource, scope()),
    filter: (principal, permission, type: ResourceType) => authorizer.filter(principal, permission, type, scope()),
    filterNow: (principal, permission, type: ResourceType) => authorizer.filterNow(principal, permission, type, scope()),
    summary: (principal, at) => authorizer.summary(principal, at, scope()),
    covers: (holder, target, at) => authorizer.covers(holder, target, at, scope()),
    preload: (principal) => authorizer.preload(principal, scope()),
    invalidate: (tags) => authorizer.invalidate(tags),
    models: () => authorizer.models(),
    can: async (principal, permission, resource, subject) => (await check(input(principal, permission, resource, subject))).allowed,
    assert: async (principal, permission, resource, subject) => {
      const d = await check(input(principal, permission, resource, subject));
      if (!d.allowed) throw new AccessDenied(d);
      return d;
    },
  };
}

/**
 * An Authorizer-style host: the kit's models and fakes, plus the real RebacModel named 'rebac' over a
 * MemoryTupleStore holding `world.rebac.tuples`, configured from `world.config.rebac`.
 */
export const rebacHarness = (): BehaviourHarness => ({
  facets: ['engine', 'boot', 'clock', 'cache', 'rebac'],
  domain: DOMAIN,
  async setup(world, ctx) {
    const kit = instantiateWorld(world);
    const models: AuthorizationModel[] = [...kit.models];
    const natives: NativeFilter[] = [...kit.nativeFilters];
    if (world.rebac) models.push(new RebacModel({ store: new MemoryTupleStore(world.rebac.tuples) }));
    for (const model of models) {
      const section = world.config?.[model.name];
      const init = fakeModelInitContext({ domain: DOMAIN, permissions: kit.permissions, model: model.name, ...(section && typeof section === 'object' ? { config: section as Record<string, unknown> } : {}) });
      await model.init(init);
      natives.push(...init.registered.nativeFilters.filter((f) => !natives.includes(f)));
    }
    validateBoot({ domain: DOMAIN, models, registry: kit.permissions, combine: world.combine, adapters: kit.adapters, scopeResolvers: kit.scopeResolvers, relations: kit.relations, nativeFilters: natives });
    const config = world.config ?? {};
    const caching = ctx.facets.includes('cache') || config.cache !== undefined;
    const options: AuthorizerOptions = {
      domain: DOMAIN,
      registry: kit.permissions,
      models,
      combine: world.combine,
      adapters: kit.adapters,
      scopeResolvers: kit.scopeResolvers,
      relations: kit.relations,
      nativeFilters: natives,
      conditions: new DefaultConditionCompiler(undefined, kit.scopeResolvers, kit.adapters),
      clock: () => kit.clock.now(),
      audit: kit.audit,
      ...(caching ? { cache: new LruDecisionCache({ maxEntries: config.cache?.maxEntries, clock: () => kit.clock.now() }) } : {}),
      config: { modelTimeoutMs: config.engine?.modelTimeoutMs, maxDelegation: config.engine?.maxDelegation, explain: config.engine?.explain, neverRead: config.fields?.neverRead },
    };
    return { authz: engineAuthz(new Authorizer(options)), kit, domain: DOMAIN, audit: kit.audit, clock: kit.clock, dispose: async () => Promise.all(models.map((m) => m.dispose?.())).then(() => undefined) };
  },
});

runBehaviour(REBAC_PARTS, rebacHarness, { strict: true });
