import * as chai from 'chai';
import 'mocha';

import { fakeModelInitContext, instantiateWorld, runBehaviour, servicePrincipal, userPrincipal } from '@spinajs/authz-testing';
import type { BehaviourAuthz, BehaviourHarness, BehaviourSelector, KitWorld, SetupContext, World } from '@spinajs/authz-testing';

import { Authorizer } from '../../../src/engine/authorizer.js';
import type { AuthorizerOptions, RequestScope } from '../../../src/engine/authorizer.js';
import { LruDecisionCache } from '../../../src/engine/cache.js';
import { validateBoot } from '../../../src/engine/validate.js';
import { AccessDenied, ScopeAttributeStore, TRUE, resourceKey } from '../../../src/index.js';
import type { CheckInput, Decision, Permission, Principal, ResourceRef, ResourceType } from '../../../src/index.js';

const expect = chai.expect;
const DOMAIN = 'root';

const PARTS: readonly BehaviourSelector[] = ['B01.core', 'B02.core', 'B03.core', 'B04.core', 'B05.core', 'B06.core', 'B07.core', 'B08.core', 'B09.core', 'B14.core', 'B14.cache', 'B17.core', 'B22.core', 'B26.core', 'B36.core', 'B37.core', 'B39.core'];

class WorldAttributeStore extends ScopeAttributeStore {
  private readonly values: ReadonlyMap<string, Readonly<Record<string, unknown>>>;

  constructor(values: NonNullable<World['scopeAttributes']>['values']) {
    super();
    this.values = new Map((values ?? []).map((v) => [resourceKey(v.scope), v.attributes]));
  }

  async get(ref: ResourceRef): Promise<Readonly<Record<string, unknown>>> {
    return this.values.get(resourceKey(ref)) ?? {};
  }

  async version(): Promise<string> {
    return '';
  }
}

/** What AuthzService does over the Authorizer: one request scope (L1) per call, as each step is its own request. */
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

function engineOptions(world: World, kit: KitWorld, ctx: SetupContext): AuthorizerOptions {
  const config = world.config ?? {};
  const caching = ctx.facets.includes('cache') || config.cache !== undefined;
  const scopeAttributes = world.scopeAttributes;
  return {
    domain: DOMAIN,
    registry: kit.permissions,
    models: kit.models,
    combine: world.combine,
    adapters: kit.adapters,
    scopeResolvers: kit.scopeResolvers,
    relations: kit.relations,
    nativeFilters: kit.nativeFilters,
    clock: () => kit.clock.now(),
    audit: kit.audit,
    ...(caching ? { cache: new LruDecisionCache({ maxEntries: config.cache?.maxEntries, clock: () => kit.clock.now() }) } : {}),
    ...(scopeAttributes ? { scopeAttributes: { schemas: scopeAttributes.schemas, ...(scopeAttributes.values ? { store: new WorldAttributeStore(scopeAttributes.values) } : {}) } } : {}),
    config: {
      modelTimeoutMs: config.engine?.modelTimeoutMs,
      maxDelegation: config.engine?.maxDelegation,
      explain: config.engine?.explain,
      neverRead: config.fields?.neverRead,
      cacheTtlSeconds: config.cache?.ttlSeconds,
      auditDenials: config.audit?.denials,
    },
  };
}

const engineHarness = (): BehaviourHarness => ({
  facets: ['engine', 'boot', 'audit', 'clock', 'cache'],
  domain: DOMAIN,
  async setup(world, ctx) {
    const kit = instantiateWorld(world);
    for (const model of kit.models) {
      const section = world.config?.[model.name];
      await model.init(fakeModelInitContext({ domain: DOMAIN, permissions: kit.permissions, model: model.name, ...(section && typeof section === 'object' ? { config: section as Record<string, unknown> } : {}) }));
    }
    // The host's boot: the checks of design §6.5, then the Authorizer.
    validateBoot({ domain: DOMAIN, models: kit.models, registry: kit.permissions, combine: world.combine, adapters: kit.adapters, scopeResolvers: kit.scopeResolvers, relations: kit.relations, nativeFilters: kit.nativeFilters });
    const authorizer = new Authorizer(engineOptions(world, kit, ctx));
    return { authz: engineAuthz(authorizer), kit, domain: DOMAIN, audit: kit.audit, clock: kit.clock, dispose: async () => undefined };
  },
});

runBehaviour(PARTS, engineHarness, { strict: true });

describe('D-F5-1: a ceiling or delegate deny does not stop the models', () => {
  const alice = userPrincipal('alice');
  const f1 = { type: 'file', id: 'f1' };
  const setupCtx = (name: string): SetupContext => ({ id: 'B36', part: 'f3', case: name, title: name, facets: ['engine'] });
  const run = async (world: World, principal: Principal) => {
    const session = await engineHarness().setup(world, setupCtx('D-F5-1'));
    try {
      const decision = await session.authz!.check({ principal, permission: 'file:read', resource: f1 });
      return {
        decision,
        calls: session
          .kit!.staticModel('m1')
          .calls.filter((c) => c.method === 'evaluate')
          .map((c) => (c.args[0] as { principal: Principal }).principal.id),
      };
    } finally {
      await session.dispose();
    }
  };

  it('intersect: the delegate is checked after the own models deny, and its reason (200) beats no_access (400)', async () => {
    const agent = servicePrincipal('svc', { onBehalfOf: alice, delegation: 'intersect' });
    const world: World = { permissions: ['file:read'], combine: { default: { algorithm: 'deny-overrides', models: ['m1'] } }, models: [{ kind: 'static', name: 'm1', votes: () => ({}) }] };
    const { decision, calls } = await run(world, agent);
    expect(decision.allowed).to.equal(false);
    expect(decision.reason).to.deep.include({ code: 'delegate', delegate: 'user:alice' });
    expect([...calls].sort()).to.deep.equal(['alice', 'svc']);
  });

  it('intersect: an own model reason of priority 100 beats the delegate denial', async () => {
    const agent = servicePrincipal('svc', { onBehalfOf: alice, delegation: 'intersect' });
    const world: World = { permissions: ['file:read'], combine: { default: { algorithm: 'deny-overrides', models: ['m1'] } }, models: [{ kind: 'static', name: 'm1', votes: (req) => (req.principal.id === 'svc' ? { denyWhen: TRUE, reason: { code: 'agents_disabled', priority: 100 } } : {}) }] };
    const { decision, calls } = await run(world, agent);
    expect(decision.reason).to.deep.include({ code: 'agents_disabled', priority: 100, model: 'm1' });
    expect([...calls].sort()).to.deep.equal(['alice', 'svc']);
  });

  it('a ceiling denial (200) still runs the models, whose reason of priority 100 wins', async () => {
    const capped = userPrincipal('alice', { ceiling: { permissions: ['other:*'] } });
    const world: World = { permissions: ['file:read'], combine: { default: { algorithm: 'deny-overrides', models: ['m1'] } }, models: [{ kind: 'static', name: 'm1', votes: () => ({ denyWhen: TRUE, reason: { code: 'agents_disabled', priority: 100 } }) }] };
    const { decision, calls } = await run(world, capped);
    expect(decision.allowed).to.equal(false);
    expect(decision.reason).to.deep.include({ code: 'agents_disabled', model: 'm1' });
    expect(calls).to.deep.equal(['alice']);
  });
});
