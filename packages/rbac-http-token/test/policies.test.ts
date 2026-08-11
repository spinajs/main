import 'mocha';
import * as chai from 'chai';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'reflect-metadata';
import { DI } from '@spinajs/di';
import { AccessControl } from 'accesscontrol';
import { ACL_CONTROLLER_DESCRIPTOR } from '@spinajs/rbac-http';

import { TokenPolicy } from '../src/policies/TokenPolicy.js';
import { NoTokenAuthPolicy } from '../src/policies/NoTokenAuthPolicy.js';

chai.use(chaiAsPromised);

describe('token policies', function () {
  before(async () => {
    // Minimal AccessControl with a grant for resource test.resource
    const ac = new AccessControl({
      user: { 'test.resource': { 'read:own': ['*'] } },
    });
    DI.register(ac).asValue('AccessControl');
  });

  after(() => {
    DI.clearCache();
  });

  const routeDescriptor = (resource: string, permission: string[]) => {
    // Mimics what @Resource/@Permission decorators put on the controller:
    // instance-level descriptor with per-route permission map.
    const instance = {};
    Reflect.defineMetadata(ACL_CONTROLLER_DESCRIPTOR, { Resource: resource, Permission: permission, Routes: new Map() }, instance);
    return instance as any;
  };

  const action: any = { Method: 'testMethod' };

  it('TokenPolicy rejects request without token auth', async () => {
    const policy = new TokenPolicy();
    const req: any = { storage: {} };
    await expect(policy.execute(req, action, routeDescriptor('test.resource', ['readOwn']))).to.be.rejected;
  });

  it('TokenPolicy accepts token-authenticated request with matching grant', async () => {
    const policy = new TokenPolicy();
    const req: any = { storage: { TokenAuth: { Uuid: 'x' }, User: { Role: ['user'] }, ActiveRole: 'user' } };
    await expect(policy.execute(req, action, routeDescriptor('test.resource', ['readOwn']))).to.be.fulfilled;
  });

  it('TokenPolicy rejects token-authenticated request without grant', async () => {
    const policy = new TokenPolicy();
    const req: any = { storage: { TokenAuth: { Uuid: 'x' }, User: { Role: ['user'] }, ActiveRole: 'user' } };
    await expect(policy.execute(req, action, routeDescriptor('test.resource', ['updateAny']))).to.be.rejected;
  });

  it('TokenPolicy errors on route without rbac descriptor', async () => {
    const policy = new TokenPolicy();
    const req: any = { storage: { TokenAuth: { Uuid: 'x' }, User: { Role: ['user'] } } };
    await expect(policy.execute(req, action, {} as any)).to.be.rejected;
  });

  it('NoTokenAuthPolicy rejects token-authenticated request', async () => {
    const policy = new NoTokenAuthPolicy();
    const req: any = { storage: { TokenAuth: { Uuid: 'x' } } };
    await expect(policy.execute(req, action, {} as any)).to.be.rejected;
  });

  it('NoTokenAuthPolicy passes session request', async () => {
    const policy = new NoTokenAuthPolicy();
    const req: any = { storage: { User: {}, Session: {} } };
    await expect(policy.execute(req, action, {} as any)).to.be.fulfilled;
  });
});
