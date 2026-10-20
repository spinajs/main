import 'mocha';
import { expect } from 'chai';
import { BaseController, BasePath, Get, Ok, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { FakeRbacModel, userPrincipal } from '@spinajs/authz-testing';

import { Access } from '../../src/index.js';
import { startApp, stopApp } from '../support/app.js';
import type { TestApp } from '../support/app.js';
import { createDomain } from '../support/domain.js';
import type { TestDomain } from '../support/domain.js';
import { registerHeaderSource } from '../support/principals.js';

const D = 'ghost';

@BasePath('ghost')
class ProbeController extends BaseController {
  @Get('read')
  @Access('probe:read', { domain: D })
  public read(@Req() _req: Request) {
    return new Ok({ read: true });
  }

  @Get('write')
  @Access('probe:write', { domain: D })
  public write(@Req() _req: Request) {
    return new Ok({ write: true });
  }
}

/**
 * A role the authorization model does not know reads as "grants nothing", never as an error: a
 * principal holding `['user', 'ghost-role']` must neither blow up the check with a library error
 * (500) nor lose what `user` alone grants, and a principal holding only the unknown role is
 * refused 403 (B12: an unknown role on a stored assignment is ignored).
 */
describe('AccessPolicy - unknown role handling', function () {
  this.timeout(30000);

  let app: TestApp;
  let domain: TestDomain;
  let unregisterSource: () => void;

  const rbac = new FakeRbacModel({
    roles: { user: ['probe:read'] },
    assignments: [
      { subject: { type: 'user', id: 'mixed' }, role: 'user' },
      { subject: { type: 'user', id: 'mixed' }, role: 'ghost-role' },
      { subject: { type: 'user', id: 'lonely' }, role: 'ghost-role' },
    ],
  });

  before(async () => {
    unregisterSource = registerHeaderSource();
    app = await startApp({ controllers: [ProbeController] });
    domain = await createDomain(D, { permissions: { 'probe:read': {}, 'probe:write': {} }, model: { votes: () => ({}) }, extraModel: rbac });
  });

  after(async () => {
    await domain?.dispose();
    await stopApp();
    unregisterSource();
  });

  it('a check for a principal holding a known and an unknown role does not throw and grants what the known role grants', async () => {
    const principal = userPrincipal('mixed');

    const read = await domain.authz.check({ principal, permission: 'probe:read', resource: { type: 'probe' } });
    expect(read.allowed).to.eq(true);

    const write = await domain.authz.check({ principal, permission: 'probe:write', resource: { type: 'probe' } });
    expect(write.allowed, 'the unknown role must grant nothing').to.eq(false);
  });

  it('a check for a principal holding only an unknown role does not throw and reports not granted', async () => {
    const decision = await domain.authz.check({ principal: userPrincipal('lonely'), permission: 'probe:read', resource: { type: 'probe' } });

    expect(decision.allowed).to.eq(false);
    expect(decision.reason?.code).to.eq('no_access');
  });

  it('a request of a principal holding a known and an unknown role is allowed on the route the known role grants', async () => {
    const res = await app.request().get('/ghost/read').set('x-user', 'mixed');

    expect(res.status).to.eq(200);
    expect((await app.request().get('/ghost/write').set('x-user', 'mixed')).status).to.eq(403);
  });

  it('AccessPolicy rejects with 403 Forbidden, not a raw library error, for a request carrying only an unknown role', async () => {
    const res = await app.request().get('/ghost/read').set('x-user', 'lonely');

    expect(res.status).to.eq(403);
    expect(res.body).to.deep.include({ error: 'forbidden', permission: 'probe:read' });
  });
});
