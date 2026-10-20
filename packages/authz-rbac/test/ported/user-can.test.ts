import * as chai from 'chai';
import 'mocha';

import { AuthorizationModel, AuthzContributor, AuthzService, GLOBAL, ResourceAdapter } from '@spinajs/authz';
import type { Assignment, Principal, ResourceRef } from '@spinajs/authz';
import { FakeAdapter, testHost, userPrincipal } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';

import { MemoryAssignmentStore, MemoryRoleStore, RbacContributor, RbacModel } from '../../src/index.js';
import type { RoleDef } from '../../src/index.js';

const expect = chai.expect;
const { installHost, instance, registerInRoot, resetHost, uninstallHost } = testHost;

// Ported from users legacy-v2/user.test.ts rows 16-23 (B11, B15): `User.canXAny` and `User.canXOwn` on the 2.x AccessControl become
// `authz().check` on the principal of the user. `any` is an allowed decision with the unconditional residual; `own` is an allowed
// decision, with or without a condition, because an `any` grant covers `own` (B15).
const articleRef: ResourceRef = { type: 'Article' };
const ACTIONS = ['create', 'read', 'update', 'delete'] as const;
const PERMISSIONS = ACTIONS.map((a) => ({ name: `Article:${a}`, types: ['Article'] }));

const role = (name: string, grants: RoleDef['grants']): RoleDef => ({ name, extends: [], assignable: true, source: 'test', grants });
const assignment = (id: string, who: string, roleName: string): Assignment => ({ id, subject: { type: 'user', id: who }, role: roleName, scope: GLOBAL, source: 'test' });

// editor has full :any grants on Article; viewer only has read:own
const ROLES: RoleDef[] = [role('editor', ACTIONS.map((a) => ({ permission: `Article:${a}` }))), role('viewer', [{ permission: 'Article:read', relation: 'owner' }])];

describe('User.can* as authz().check', function () {
  this.timeout(10000);

  before(() => installHost());
  after(() => uninstallHost());

  beforeEach(async () => {
    await resetHost();
    testHost.config().set(['authz', 'permissions'], Object.fromEntries(PERMISSIONS.map(({ name, types }) => [name, { types }])));
    const model = new RbacModel({ roles: new MemoryRoleStore(ROLES), assignments: new MemoryAssignmentStore([assignment('a1', 'editor1', 'editor'), assignment('a2', 'viewer1', 'viewer')]) });
    registerInRoot(AuthorizationModel, instance(model));
    registerInRoot(AuthzContributor, instance(new RbacContributor(model)));
    registerInRoot(ResourceAdapter, instance(new FakeAdapter({ types: ['Article'], rows: { Article: [] }, relations: [{ type: 'Article', relation: 'owner', column: 'owner' }] })));
  });

  const editor = (): Principal => userPrincipal('editor1');
  const viewer = (): Principal => userPrincipal('viewer1');

  const canAny = async (p: Principal, action: (typeof ACTIONS)[number]): Promise<boolean> => {
    const svc = (await DI.resolve(AuthzService)) as AuthzService;
    const decision = await svc.check({ principal: p, permission: `Article:${action}`, resource: articleRef });
    return decision.allowed && decision.residual?.op === 'true';
  };
  const canOwn = async (p: Principal, action: (typeof ACTIONS)[number]): Promise<boolean> => {
    const svc = (await DI.resolve(AuthzService)) as AuthzService;
    return (await svc.check({ principal: p, permission: `Article:${action}`, resource: articleRef })).allowed;
  };

  it('canReadAny should work', async () => {
    expect(await canAny(editor(), 'read')).to.equal(true);
    expect(await canAny(viewer(), 'read')).to.equal(false);
  });

  it('canUpdateAny should work', async () => {
    expect(await canAny(editor(), 'update')).to.equal(true);
    expect(await canAny(viewer(), 'update')).to.equal(false);
  });

  it('canDeleteAny should work', async () => {
    expect(await canAny(editor(), 'delete')).to.equal(true);
    expect(await canAny(viewer(), 'delete')).to.equal(false);
  });

  it('canCreateAny should work', async () => {
    expect(await canAny(editor(), 'create')).to.equal(true);
    expect(await canAny(viewer(), 'create')).to.equal(false);
  });

  it('canReadOwn should work', async () => {
    // an :any grant implies :own
    expect(await canOwn(editor(), 'read')).to.equal(true);
    expect(await canOwn(viewer(), 'read')).to.equal(true);
  });

  it('canUpdateOwn should work', async () => {
    expect(await canOwn(editor(), 'update')).to.equal(true);
    expect(await canOwn(viewer(), 'update')).to.equal(false);
  });

  it('canDeleteOwn should work', async () => {
    expect(await canOwn(editor(), 'delete')).to.equal(true);
    expect(await canOwn(viewer(), 'delete')).to.equal(false);
  });

  it('canCreateOwn should work', async () => {
    expect(await canOwn(editor(), 'create')).to.equal(true);
    expect(await canOwn(viewer(), 'create')).to.equal(false);
  });
});
