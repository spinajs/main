import 'mocha';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { AccessControl } from 'accesscontrol';
import { DI } from '@spinajs/di';
import { Forbidden } from '@spinajs/exceptions';

import { RbacPolicy, checkRbacPermission, checkUserPermission, checkRoutePermission } from '../src/policies/RbacPolicy.js';
import { Resource, Permission } from '../src/decorators.js';

chai.use(chaiAsPromised);

@Resource('probe.resource', ['readOwn'])
class ProbeController {
  @Permission(['readOwn'])
  public async get() {
    /* body irrelevant, only ACL metadata matters */
  }
}

/**
 * A role absent from `rbac.grants` must read as "not granted", never crash
 * the check. `accesscontrol` throws `AccessControlError` ("Role not found")
 * for any unknown role name and rejects the WHOLE role array on one unknown
 * member - so a session or token carrying `['user', 'ghost-role']` used to
 * blow up `ac.can(...)` with a raw library error (500), even on a route
 * `user` alone fully grants.
 */
describe('RbacPolicy - unknown role handling', function () {
  const ac = () => new AccessControl({ user: { 'probe.resource': { 'read:own': ['*'] } } });

  afterEach(() => {
    DI.clearCache();
  });

  it('checkRoutePermission does not throw for an unknown role and reports not granted', () => {
    DI.register(ac()).asValue('AccessControl');

    const req: any = { storage: { User: { Role: ['user', 'ghost-role'] } } };

    expect(() => checkRoutePermission(req, 'probe.resource', 'readOwn')).to.not.throw();
    expect(checkRoutePermission(req, 'probe.resource', 'readOwn')?.granted).to.not.equal(true);
  });

  it('checkUserPermission does not throw for an unknown role and reports not granted', () => {
    DI.register(ac()).asValue('AccessControl');

    const user: any = { Role: ['user', 'ghost-role'] };

    expect(() => checkUserPermission(user, 'probe.resource', 'readOwn')).to.not.throw();
    expect(checkUserPermission(user, 'probe.resource', 'readOwn')?.granted).to.not.equal(true);
  });

  it('checkRbacPermission does not throw for an unknown role and reports not granted', () => {
    DI.register(ac()).asValue('AccessControl');

    expect(() => checkRbacPermission(['user', 'ghost-role'], 'probe.resource', 'readOwn')).to.not.throw();
    expect(checkRbacPermission(['user', 'ghost-role'], 'probe.resource', 'readOwn')?.granted).to.not.equal(true);
  });

  it('RbacPolicy.execute rejects with Forbidden, not a raw AccessControlError, for a request carrying an unknown role', async () => {
    DI.register(ac()).asValue('AccessControl');

    const policy = new RbacPolicy();
    // Only the ACL metadata `RbacPolicy.execute` reads off the instance matters here -
    // `IController`'s Router/Descriptor/BasePath are irrelevant to this check.
    const instance = new ProbeController() as any;
    const req: any = {
      storage: {
        User: { Role: ['user', 'ghost-role'] },
        Session: { Data: new Map([['Authorized', true]]) },
      },
    };
    const action: any = { Method: 'get' };

    await expect(policy.execute(req, action, instance)).to.be.rejectedWith(Forbidden);
  });
});
