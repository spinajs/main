import { AuthzConfigError, PermissionRegistryImpl, TRUE } from '@spinajs/authz';
import { bootConfiguration, fakeEvaluationContext, fakeModelInitContext, servicePrincipal } from '@spinajs/authz-testing';
import { InvalidConfiguration } from '@spinajs/configuration';
import type { IContainer } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';

import { AUTHZ_RBAC_CONFIGURATION_SCHEMA, MemoryAssignmentStore, MemoryRoleStore, RbacModel } from '../../src/index.js';

const expect = chai.expect;

async function init(serviceRoles: Record<string, string[]>): Promise<RbacModel> {
  const permissions = new PermissionRegistryImpl();
  permissions.register([{ name: 'doc:read' }], 'test');
  permissions.freeze();
  const roles = new MemoryRoleStore([{ name: 'operator', extends: [], assignable: true, source: 'test', grants: [{ permission: 'doc:read' }] }]);
  const model = new RbacModel({ roles, assignments: new MemoryAssignmentStore() });
  await model.init(fakeModelInitContext({ model: 'rbac', config: { serviceRoles }, permissions }));
  return model;
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}

describe('authz-rbac serviceRoles keys name the principal type', function () {
  this.timeout(20000);

  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(serviceRoles: Record<string, string[]>): Promise<void> {
    const booted = await bootConfiguration({ authz: { rbac: { serviceRoles } } }, [AUTHZ_RBAC_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
  }

  for (const key of ['lan', ':lan', 'service:', 'service:*']) {
    it(`the configuration refuses the key '${key}', showing the <type>:<id> form`, async () => {
      const err = await rejection(boot({ [key]: ['operator'] }));
      expect(err).to.be.instanceOf(InvalidConfiguration);
      const violation = (err as InvalidConfiguration).violations.find((v) => v.path === `authz.rbac.serviceRoles.${key}`);
      expect(violation?.message, err.message).to.include('(?<type>[^:]+):(?<id>');
    });
  }

  it("the configuration takes 'service:lan' and an id holding a colon", async () => {
    await boot({ 'service:lan': ['operator'], 'service:a:b': ['operator'] });
  });

  for (const [key, fragment] of [
    ['lan', "must be a principal key '<type>:<id>', for example 'service:lan'"],
    [':lan', "must be a principal key '<type>:<id>'"],
    ['service:', "must be a principal key '<type>:<id>'"],
    ['service:*', "names the wildcard of 'service'"],
  ] as const) {
    it(`the model refuses the key '${key}' at init`, async () => {
      const err = await rejection(init({ [key]: ['operator'] }));
      expect(err).to.be.instanceOf(AuthzConfigError);
      expect(err.message).to.include(`authz.rbac.serviceRoles['${key}'] ${fragment}`);
    });
  }

  it("the model takes 'service:lan' and gives that principal the role", async () => {
    const model = await init({ 'service:lan': ['operator'] });
    const vote = await model.evaluate({ principal: servicePrincipal('lan'), permission: 'doc:read', resource: { type: 'doc', id: '1' } }, fakeEvaluationContext());
    expect(vote.permitWhen).to.deep.equal(TRUE);
  });
});
