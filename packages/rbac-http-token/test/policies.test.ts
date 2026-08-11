import 'mocha';
import * as chai from 'chai';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'reflect-metadata';
import { DI } from '@spinajs/di';
import { AccessControl } from 'accesscontrol';
import { ACL_CONTROLLER_DESCRIPTOR } from '@spinajs/rbac-http';
import { AuthenticationFailed, Forbidden } from '@spinajs/exceptions';
import { ServerError } from '@spinajs/http';

import { TokenPolicy } from '../src/policies/TokenPolicy.js';
import { NoTokenAuthPolicy } from '../src/policies/NoTokenAuthPolicy.js';
import { NoImpersonationPolicy } from '../src/policies/NoImpersonationPolicy.js';

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
    // 401, not 403: no credential was presented at all
    await expect(policy.execute(req, action, routeDescriptor('test.resource', ['readOwn']))).to.be.rejectedWith(AuthenticationFailed);
  });

  it('TokenPolicy accepts token-authenticated request with matching grant', async () => {
    const policy = new TokenPolicy();
    const req: any = { storage: { TokenAuth: { Uuid: 'x' }, User: { Role: ['user'] }, ActiveRole: 'user' } };
    await expect(policy.execute(req, action, routeDescriptor('test.resource', ['readOwn']))).to.be.fulfilled;
  });

  it('TokenPolicy rejects token-authenticated request without grant', async () => {
    const policy = new TokenPolicy();
    const req: any = { storage: { TokenAuth: { Uuid: 'x' }, User: { Role: ['user'] }, ActiveRole: 'user' } };
    // 403, not 401: the token authenticated fine, the grant is what is missing
    await expect(policy.execute(req, action, routeDescriptor('test.resource', ['updateAny']))).to.be.rejectedWith(Forbidden);
  });

  it('TokenPolicy errors on route without rbac descriptor', async () => {
    const policy = new TokenPolicy();
    const req: any = { storage: { TokenAuth: { Uuid: 'x' }, User: { Role: ['user'] } } };

    // `.rejectedWith(ServerError)` cannot be used here: http's ServerError is a
    // Response class ( extends BadRequestResponse ), not an Error subclass, and
    // chai's check-error rejects any constructor whose prototype is not an
    // Error. Asserted by hand so the type is still pinned - the point of this
    // test is that the missing descriptor yields ServerError rather than a raw
    // TypeError from dereferencing `descriptor.Routes`.
    let thrown: unknown;
    try {
      await policy.execute(req, action, {} as any);
    } catch (err) {
      thrown = err;
    }

    expect(thrown, 'expected the policy to reject').to.not.be.undefined;
    expect(thrown).to.be.instanceOf(ServerError);
    expect(thrown).to.not.be.instanceOf(TypeError);
  });

  it('NoTokenAuthPolicy rejects token-authenticated request', async () => {
    const policy = new NoTokenAuthPolicy();
    const req: any = { storage: { TokenAuth: { Uuid: 'x' } } };
    await expect(policy.execute(req, action, {} as any)).to.be.rejectedWith(Forbidden);
  });

  it('NoTokenAuthPolicy passes session request', async () => {
    const policy = new NoTokenAuthPolicy();
    const req: any = { storage: { User: {}, Session: {} } };
    await expect(policy.execute(req, action, {} as any)).to.be.fulfilled;
  });

  /**
   * This policy only ever asks "was a token used?". A guest request has no
   * token, so it must pass - rejecting here would turn a defence-in-depth
   * guard into a second, accidental authentication check.
   */
  it('NoTokenAuthPolicy passes guest request', async () => {
    const policy = new NoTokenAuthPolicy();
    const req: any = { storage: {} };
    await expect(policy.execute(req, action, {} as any)).to.be.fulfilled;
  });

  it('NoImpersonationPolicy rejects an impersonated session', async () => {
    const policy = new NoImpersonationPolicy();
    // what RbacMiddleware builds from the `Impersonator` session key: User is
    // the TARGET, Impersonator is whoever started it
    const req: any = { storage: { User: { Uuid: 'victim' }, Session: {}, Impersonator: { Uuid: 'admin' } } };
    await expect(policy.execute(req, action, {} as any)).to.be.rejectedWith(Forbidden);
  });

  it('NoImpersonationPolicy passes an ordinary session', async () => {
    const policy = new NoImpersonationPolicy();
    const req: any = { storage: { User: { Uuid: 'someone' }, Session: {} } };
    await expect(policy.execute(req, action, {} as any)).to.be.fulfilled;
  });

  /**
   * Like its sibling, this policy answers ONE question - "is somebody acting as
   * somebody else?". No impersonation means pass, whoever the caller is;
   * authentication is RbacPolicy's job.
   */
  it('NoImpersonationPolicy passes guest request', async () => {
    const policy = new NoImpersonationPolicy();
    const req: any = { storage: {} };
    await expect(policy.execute(req, action, {} as any)).to.be.fulfilled;
  });
});
