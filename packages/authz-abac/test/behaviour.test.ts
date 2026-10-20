import 'mocha';
import { AccessDenied, Authorizer, DefaultConditionCompiler, LruDecisionCache, validateBoot } from '@spinajs/authz';
import type { AuthorizationModel, AuthorizerOptions, CheckInput, Decision, Permission, Principal, RequestScope, ResourceRef, ResourceType } from '@spinajs/authz';
import { fakeModelInitContext, instantiateWorld, runBehaviour } from '@spinajs/authz-testing';
import type { BehaviourAuthz, BehaviourHarness, BehaviourSelector } from '@spinajs/authz-testing';

import { AbacModel, ConfigPolicyStore } from '../src/index.js';

const DOMAIN = 'root';

/** The parts of the B-rules that L3 owns (plan §3 L3 task 8, r6 item 2). */
export const ABAC_PARTS: readonly BehaviourSelector[] = ['B02.abac', 'B03.abac', 'B04.abac', 'B05.abac', 'B14.abac', 'B17.abac', 'B18.abac', 'B19.abac', 'B26.abac', 'B36.abac', 'B39.abac'];

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
 * An Authorizer-style host (as F3's engine harness): the kit's models and fakes, plus the real
 * AbacModel named 'abac' over `world.abac.policies`, the core condition compiler, and the boot
 * checks fed with the ABAC model's refs (what AbacContributor gives the host).
 */
export const abacHarness = (): BehaviourHarness => ({
  facets: ['engine', 'boot', 'clock', 'cache', 'abac', 'conditions'],
  domain: DOMAIN,
  async setup(world, ctx) {
    const kit = instantiateWorld(world);
    const models: AuthorizationModel[] = [...kit.models];
    let abac: AbacModel | undefined;
    if (world.abac) {
      abac = new AbacModel({ stores: [new ConfigPolicyStore(world.abac.policies)] });
      models.push(abac);
    }
    for (const model of models) {
      const section = world.config?.[model.name];
      await model.init(fakeModelInitContext({ domain: DOMAIN, permissions: kit.permissions, model: model.name, ...(section && typeof section === 'object' ? { config: section as Record<string, unknown> } : {}) }));
    }
    const refs = abac?.contribution() ?? {};
    validateBoot({ domain: DOMAIN, models, registry: kit.permissions, combine: world.combine, adapters: kit.adapters, scopeResolvers: kit.scopeResolvers, relations: kit.relations, nativeFilters: kit.nativeFilters, ...refs });
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
      nativeFilters: kit.nativeFilters,
      conditions: new DefaultConditionCompiler(undefined, kit.scopeResolvers, kit.adapters),
      clock: () => kit.clock.now(),
      audit: kit.audit,
      ...(caching ? { cache: new LruDecisionCache({ maxEntries: config.cache?.maxEntries, clock: () => kit.clock.now() }) } : {}),
      config: { modelTimeoutMs: config.engine?.modelTimeoutMs, maxDelegation: config.engine?.maxDelegation, explain: config.engine?.explain, neverRead: config.fields?.neverRead },
    };
    return { authz: engineAuthz(new Authorizer(options)), kit, domain: DOMAIN, audit: kit.audit, clock: kit.clock, dispose: async () => undefined };
  },
});

runBehaviour(ABAC_PARTS, abacHarness, { strict: true });
