import * as chai from 'chai';
import 'mocha';
import { StaticModel, userPrincipal } from '@spinajs/authz-testing';

import { AuthorizationModel, AuthzAdminFailure, AuthzConfigError, SYSTEM, TRUE, assertAdminPermission } from '@spinajs/authz';
import type { AdminCallContext, ResourceRef } from '@spinajs/authz';

import { START, adminConfig, adminDomain, installHost, instance, rejection, resetHost, uninstallHost } from './support.js';
import type { AdminDomain } from './support.js';

const expect = chai.expect;

const P1: ResourceRef = { type: 'project', id: 'p1' };
const D1: ResourceRef = { type: 'doc', id: 'd1' };

/** dave holds only app:settings.manage. */
const daveModel = (): StaticModel => new StaticModel({ name: 'dave', votes: (req) => (req.principal.id === 'dave' && req.permission === 'app:settings.manage' ? { permitWhen: TRUE } : {}) });

describe('assertAdminPermission', function () {
  this.timeout(20000);
  let d: AdminDomain;

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
  });

  const ctxOf = (id: string): AdminCallContext => Object.freeze({ domain: d.name, now: START, authz: d.service, actor: id === 'SYSTEM' ? SYSTEM : userPrincipal(id), container: d.container, dryRun: false });

  it('passes an unconditional allow and SYSTEM, and refuses a deny or a conditional allow as AuthzAdmin does', async () => {
    adminConfig();
    d = await adminDomain();
    await assertAdminPermission(ctxOf('alice'), 'policy.put', P1, 'app:members.manage');
    await assertAdminPermission(ctxOf('SYSTEM'), 'policy.put', P1, 'app:members.manage');
    const denied = (await rejection(assertAdminPermission(ctxOf('bob'), 'policy.put', P1, 'app:members.manage'))) as AuthzAdminFailure;
    expect(denied).to.be.instanceOf(AuthzAdminFailure);
    expect(denied.code).to.equal('forbidden');
    expect(denied.message).to.equal('user:bob may not app:members.manage on project:p1 (no_access)');
    const conditional = (await rejection(assertAdminPermission(ctxOf('carol'), 'policy.put', P1, 'app:members.manage'))) as AuthzAdminFailure;
    expect(conditional.code).to.equal('forbidden');
    expect(conditional.message).to.match(/only conditionally/);
  });

  it('maps the permission through authz.admin.permissions, exact kind and scope type first', async () => {
    adminConfig({ permissions: { 'policy.*': { project: 'app:settings.manage' } } });
    d = await adminDomain('test', { register: (c) => c.register(instance(daveModel())).as(AuthorizationModel) });
    await assertAdminPermission(ctxOf('dave'), 'policy.put', P1, 'app:members.manage');
    // No entry for doc: the fallback, which dave does not hold.
    expect(((await rejection(assertAdminPermission(ctxOf('dave'), 'policy.put', D1, 'app:members.manage'))) as AuthzAdminFailure).code).to.equal('forbidden');
  });

  it('needs the AdminCallContext AuthzAdmin passes', async () => {
    adminConfig();
    d = await adminDomain();
    const bare = { domain: d.name, now: START, authz: d.service };
    expect(await rejection(assertAdminPermission(bare, 'policy.put', P1, 'app:members.manage'))).to.be.instanceOf(AuthzConfigError);
  });
});
