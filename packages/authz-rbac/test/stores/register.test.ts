import { expect } from 'chai';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { AdminAssignmentStore, AdminLinkStore, AdminRuleStore, AssignmentStore, ConfigRoleStore, ConfigRuleStore, DbAssignmentStore, DbLinkStore, DbRuleStore, LinkStore, RoleStore, RuleStore, rbacStoreNames, registerRbacStores } from '../../src/index.js';

const DB_STORES = { roles: ['ConfigRoleStore'], assignments: ['DbAssignmentStore'], rules: ['DbRuleStore'], links: ['DbLinkStore'] };

/** A role store another package registers by its class name. */
class ExtraRoleStore extends RoleStore {
  readonly name = 'ExtraRoleStore';
  async load() {
    return { roles: [], ladders: [] };
  }
  async version() {
    return '1';
  }
}

describe('registerRbacStores', () => {
  let container: IContainer;
  const config = (stores?: Record<string, string[]>) => {
    const cfg = new testHost.TestConfiguration();
    if (stores) cfg.set(['authz', 'rbac', 'stores'], stores);
    return cfg;
  };

  beforeEach(() => {
    container = DI.child();
  });

  afterEach(async () => {
    await container.dispose();
  });

  it('registers the stores authz.rbac.stores names under the model tokens and the AuthzAdmin ports', () => {
    const cfg = config(DB_STORES);
    container.register(testHost.instance(cfg)).as(Configuration);

    registerRbacStores(container, cfg);

    expect(container.resolve(RoleStore)).to.be.instanceOf(ConfigRoleStore);
    const assignments = container.resolve(AdminAssignmentStore);
    expect(assignments).to.be.instanceOf(DbAssignmentStore);
    expect(container.resolve(AssignmentStore)).to.eq(assignments);
    expect(container.resolve(AdminRuleStore)).to.be.instanceOf(DbRuleStore);
    expect(container.resolve(RuleStore)).to.eq(container.resolve(AdminRuleStore));
    expect(container.resolve(AdminLinkStore)).to.be.instanceOf(DbLinkStore);
    expect(container.resolve(LinkStore)).to.eq(container.resolve(AdminLinkStore));
    expect(DI.RootContainer.hasRegistered(RoleStore)).to.eq(false);
  });

  it('registers a store of another package under its port, in the configured order', async () => {
    container.register(ExtraRoleStore).asSelf();
    const cfg = config({ ...DB_STORES, roles: ['ConfigRoleStore', 'ExtraRoleStore'] });
    container.register(testHost.instance(cfg)).as(Configuration);

    registerRbacStores(container, cfg);

    const chain = (await container.resolve(Array.chainOf(RoleStore))) as RoleStore[];
    expect(chain.map((s) => s.name)).to.deep.eq(['ConfigRoleStore', 'ExtraRoleStore']);
  });

  it('registers the default store config cleanly, ConfigRuleStore as the RuleStore', () => {
    const cfg = config();
    container.register(testHost.instance(cfg)).as(Configuration);

    registerRbacStores(container, cfg);

    expect(container.resolve(RoleStore)).to.be.instanceOf(ConfigRoleStore);
    expect(container.resolve(RuleStore)).to.be.instanceOf(ConfigRuleStore);
    expect(container.hasRegistered(AdminRuleStore, false)).to.eq(false);
    expect(container.hasRegistered(AssignmentStore, false)).to.eq(true);
    expect(container.hasRegistered(LinkStore, false)).to.eq(true);
    expect(DI.RootContainer.hasRegistered(RuleStore)).to.eq(false);
  });

  it('registers DbMembershipStore by default next to DbAssignmentStore, and none next to another assignment store', () => {
    const cfg = (stores: Record<string, unknown> | undefined) => ({ get: (path: unknown) => (JSON.stringify(path) === JSON.stringify(['authz', 'rbac', 'stores', 'membership']) ? undefined : JSON.stringify(path) === JSON.stringify(['authz', 'rbac', 'stores', 'assignments']) ? stores?.assignments : undefined) } as never);
    expect(rbacStoreNames(cfg(undefined), 'membership')).to.deep.equal(['DbMembershipStore']);
    expect(rbacStoreNames(cfg({ assignments: ['MemoryAssignmentStore'] }), 'membership')).to.deep.equal([]);
  });

  it('refuses an unknown name or a class of another port, naming the key, and registers nothing', () => {
    expect(() => registerRbacStores(container, config({ ...DB_STORES, assignments: ['NoSuchStore'] }))).to.throw(AuthzConfigError, /authz\.rbac\.stores\.assignments: .*"NoSuchStore"/);
    expect(() => registerRbacStores(container, config({ ...DB_STORES, links: ['DbAssignmentStore'] }))).to.throw(AuthzConfigError, /authz\.rbac\.stores\.links: "DbAssignmentStore" is not a LinkStore/);
    for (const token of ['RoleStore', 'AssignmentStore', 'AdminAssignmentStore', 'RuleStore', 'LinkStore']) expect(container.hasRegistered(token, false), token).to.eq(false);
  });
});
