import { AuthorizationModel, AuthzConfigError, AuthzContributor, GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import type { Assignment, PermissionInput, Principal, ResourceRef, Vote } from '@spinajs/authz';
import { FakeScopeResolver, fakeEvaluationContext, fakeModelInitContext, testHost, userPrincipal } from '@spinajs/authz-testing';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';

import { ConfigRoleStore, ConfigRuleStore, LINK_INVALID, LinkStore, MemoryAdminAssignmentStore, MemoryLinkStore, MemoryRoleStore, RBAC_SERVICE_NAME, RbacContributor, RbacLinkResolver, RbacModel, RbacService, RoleStore, RuleStore, linkCompanion, registerRbac } from '../../src/index.js';
import type { RoleDef } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const HOUR = 3_600_000;
const r = (type: string, id: string): ResourceRef => ({ type, id });
const [O1, P1, P2, f1, f2] = [r('org', 'o1'), r('project', 'p1'), r('project', 'p2'), r('file', 'f1'), r('file', 'f2')];
const role = (name: string, grants: string[]): RoleDef => ({ name, extends: [], assignable: true, source: 'test', grants: grants.map((permission) => ({ permission })) });
const ROLES = [role('viewer', ['file:read']), role('editor', ['file:read', 'file:edit']), role('admin', ['file:read', 'file:edit', 'file:admin'])];
const PERMISSIONS: PermissionInput[] = ['file:read', 'file:edit', 'file:admin'].map((name) => ({ name, types: ['org', 'project', 'file'] }));
const scopes = new FakeScopeResolver({ types: ['org', 'project', 'file'], nodes: [{ ref: O1 }, { ref: P1, parent: O1 }, { ref: P2, parent: O1 }, { ref: f1, parent: P1 }, { ref: f2, parent: P2 }] });
const ctx = () => fakeEvaluationContext({ now: NOW, scopeResolvers: [scopes] });
const alice = userPrincipal('alice');

function registry() {
  const reg = new PermissionRegistryImpl();
  reg.register(PERMISSIONS, 'test');
  reg.freeze();
  return reg;
}

async function world(opts: { readonly links?: boolean } = {}) {
  const rows: Assignment[] = [{ id: 'a1', subject: { type: 'user', id: 'alice' }, role: 'admin', scope: GLOBAL, source: 'test' }];
  const assignments = new MemoryAdminAssignmentStore({ assignments: rows });
  const links = new MemoryLinkStore(assignments, {
    links: [
      { link: { id: 'l1', scope: P1, expiresAt: new Date(NOW.getTime() + HOUR), attributes: { org_only: true } }, token: 'tok-l1', role: 'viewer' },
      { link: { id: 'l2', scope: P1, expiresAt: new Date(NOW.getTime() - 1), attributes: {} }, token: 'tok-l2', role: 'editor' },
    ],
  });
  const model = new RbacModel({ roles: new MemoryRoleStore(ROLES, []), assignments, ...(opts.links === false ? {} : { links }), log: { warn: () => undefined } });
  await model.init(fakeModelInitContext({ model: 'rbac', permissions: registry() }));
  return { model, links, service: new RbacService(model) };
}

const vote = (model: RbacModel, principal: Principal, permission: string, resource: ResourceRef): Promise<Vote> => Promise.resolve(model.evaluate({ principal, permission, resource }, ctx()));

describe('authz-rbac share links', () => {
  describe('linkPrincipal and principalForToken', () => {
    it('build the link principal: its subject, the ceiling of its scope and expiry, its attributes, the companion', async () => {
      const { service } = await world();
      const p = await service.linkPrincipal('l1', alice);
      expect(p).to.deep.equal({
        type: 'link',
        id: 'l1',
        authenticated: true,
        source: 'link',
        companions: [{ type: 'user', id: 'alice' }],
        ceiling: { resources: [P1], expiresAt: new Date(NOW.getTime() + HOUR), reason: LINK_INVALID },
        attributes: { org_only: true },
      });
      expect(Object.isFrozen(p) && Object.isFrozen(p.ceiling) && Object.isFrozen(p.ceiling!.resources)).to.equal(true);
      expect(await service.principalForToken('tok-l1', alice)).to.deep.equal(p);
    });

    it('an expired link keeps its expiry: the engine denies it at its own clock', async () => {
      const { service } = await world();
      expect((await service.principalForToken('tok-l2')).ceiling).to.deep.equal({ resources: [P1], expiresAt: new Date(NOW.getTime() - 1), reason: LINK_INVALID });
    });

    it('an unknown id or token covers no resource, and the token appears nowhere in the principal', async () => {
      const { service } = await world();
      const byId = await service.linkPrincipal('ghost', alice);
      expect([byId.id, byId.ceiling]).to.deep.equal(['ghost', { resources: [], reason: LINK_INVALID }]);
      const byToken = await service.principalForToken('tok-secret-ghost');
      expect([byToken.id, byToken.ceiling, byToken.attributes]).to.deep.equal(['unresolved', { resources: [], reason: LINK_INVALID }, {}]);
      expect(JSON.stringify(byToken)).to.not.contain('tok-secret-ghost');
    });

    it('without a LinkStore it refuses to guess', async () => {
      const { service } = await world({ links: false });
      let thrown: unknown;
      try {
        await service.principalForToken('tok-l1');
      } catch (e) {
        thrown = e;
      }
      expect(thrown).to.be.instanceOf(AuthzConfigError);
    });
  });

  describe('the companion never widens the link (L1 hand-off)', () => {
    const switched = { ...alice, ceiling: { roles: ['viewer'] } } as Principal;
    const expired = { ...alice, ceiling: { expiresAt: new Date(NOW.getTime() - 1) } } as Principal;
    const agent = { ...userPrincipal('bot'), onBehalfOf: alice } as Principal;
    const link = { ...userPrincipal('l9'), type: 'link' } as Principal;

    it('a plain companion joins with its own assignments', async () => {
      const { model, service } = await world();
      expect((await vote(model, await service.linkPrincipal('l1', alice), 'file:admin', f1)).permitWhen.op).to.equal('true');
    });

    it('a role-switched admin carrying a link does not regain the switched-off roles', async () => {
      const { model, service } = await world();
      const p = await service.linkPrincipal('l1', switched);
      expect(p.companions).to.equal(undefined);
      expect((await vote(model, p, 'file:admin', f1)).permitWhen.op).to.equal('false');
      expect((await vote(model, p, 'file:read', f1)).permitWhen.op).to.equal('true');
    });

    it('a companion whose token expired does not act', async () => {
      const { model, service } = await world();
      const p = await service.principalForToken('tok-l1', expired);
      expect(p.companions).to.equal(undefined);
      expect((await vote(model, p, 'file:edit', f1)).permitWhen.op).to.equal('false');
    });

    it('an agent or another link is no companion', () => {
      expect([linkCompanion(agent), linkCompanion(link), linkCompanion(undefined)]).to.deep.equal([undefined, undefined, undefined]);
      expect(linkCompanion(alice)).to.deep.equal({ type: 'user', id: 'alice' });
    });
  });

  it('summarize for a link principal lists what its assignment gives inside the link scope', async () => {
    const { model, service } = await world();
    const summary = await model.summarize(await service.linkPrincipal('l1'), P1, ctx());
    expect(summary.permissions.map((p) => p.name)).to.deep.equal(['file:read']);
  });

  it("RbacLinkResolver has authz-http's LinkResolver shape over the RbacService in DI", async () => {
    const { service } = await world();
    const container = DI.child();
    try {
      container.register(testHost.instance(service)).as(RbacService);
      const resolver = await container.resolve(RbacLinkResolver);
      expect((await resolver.principal('tok-l1', alice)).id).to.equal('l1');
      expect((await resolver.principal('nope')).ceiling?.resources).to.deep.equal([]);
    } finally {
      await container.dispose();
    }
  });

  describe('registerRbac', () => {
    let container: IContainer;
    const config = (stores?: Record<string, string[]>) => {
      const cfg = new testHost.TestConfiguration();
      if (stores) cfg.set(['authz', 'rbac', 'stores'], stores);
      container.register(testHost.instance(cfg)).as(Configuration);
      return cfg;
    };

    beforeEach(() => {
      container = DI.child();
    });

    afterEach(async () => {
      await container.dispose();
    });

    it('wires the default store config: the stores, the model, its contributor and RbacService (by class and by name)', async () => {
      const { model, contributor, service, linkResolver } = await registerRbac(container, config());
      expect(await container.resolve(RoleStore)).to.be.instanceOf(ConfigRoleStore);
      expect(await container.resolve(RuleStore)).to.be.instanceOf(ConfigRuleStore);
      expect(container.hasRegistered(LinkStore)).to.equal(true);
      expect(await container.resolve(AuthorizationModel)).to.equal(model);
      expect(contributor).to.be.instanceOf(RbacContributor);
      expect(await container.resolve(AuthzContributor)).to.equal(contributor);
      expect(await container.resolve(RbacService)).to.equal(service);
      // How check-config --explain-role finds it.
      expect(container.hasRegistered(RBAC_SERVICE_NAME) || container.isResolved(RBAC_SERVICE_NAME)).to.equal(true);
      expect(await container.resolve(RBAC_SERVICE_NAME)).to.equal(service);
      expect(model.linkStore).to.equal(await container.resolve(LinkStore));
      expect(linkResolver).to.be.instanceOf(RbacLinkResolver);
    });

    it('returns a LinkResolver bound to its RbacService, whatever container it ran on', async () => {
      const { service, links } = await world();
      const resolver = new RbacLinkResolver(service);
      expect((await resolver.principal('tok-l1')).id).to.equal('l1');
      expect(links).to.be.instanceOf(MemoryLinkStore);
    });

    it('turns rules and links off with empty lists', async () => {
      const { model } = await registerRbac(container, config({ roles: ['ConfigRoleStore'], assignments: ['DbAssignmentStore'], rules: [], links: [] }));
      expect(model.linkStore).to.equal(undefined);
      expect(container.hasRegistered(RuleStore, false)).to.equal(false);
    });

    it('refuses two stores of a kind, and a missing roles or assignments store, before registering anything', async () => {
      const refused: Record<string, string[]>[] = [{ roles: ['ConfigRoleStore', 'ConfigRoleStore2'] }, { assignments: [] }];
      for (const stores of refused) {
        let thrown: unknown;
        try {
          await registerRbac(container, config(stores));
        } catch (e) {
          thrown = e;
        }
        expect(thrown, JSON.stringify(stores)).to.be.instanceOf(AuthzConfigError);
        for (const token of [AuthorizationModel, AuthzContributor, RbacService, RoleStore, RuleStore, LinkStore].map((t) => t.name)) expect(container.hasRegistered(token, false), `${JSON.stringify(stores)} ${token}`).to.equal(false);
      }
    });
  });
});
