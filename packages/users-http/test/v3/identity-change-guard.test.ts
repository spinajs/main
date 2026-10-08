import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DefaultQueueService } from '@spinajs/queue';
import { User } from '@spinajs/users';

import { Users } from '../../src/admin/controllers/Users/Users.js';
import { globalRolesOf } from '../support/authz-host.js';
import { startUsersHttpApp, stopUsersHttpApp } from '../support/http-app.js';
import type { RoleDefs, UsersHttpApp } from '../support/http-app.js';

/**
 * `PATCH /users/:uuid` changing the Email or Login of another account (review 3, H2). The public password reset goes
 * to the e-mail address, so such a change hands the account over: it needs what authn-http's admin password reset
 * needs, authn's CredentialAdminGuard (users': `users:credentials`, the target covered, no protected role), asked
 * before anything is written. Role-only changes and changes of one's own account are not affected.
 */
describe('users-http v3: e-mail and login changes of other users need the credential admin guard', function () {
  this.timeout(120000);

  let app: UsersHttpApp;
  let userAdmin: User;
  let lowerAdmin: User;
  let protectedAdmin: User;
  let seniorAdmin: User;
  let seq = 0;

  before(async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
    app = await startUsersHttpApp({
      controllers: [Users],
      roles: (shipped: RoleDefs): RoleDefs => ({
        ...shipped,
        member: {},
        tag: {},
        'user-admin': { grants: ['users:read', 'users:update', 'users:credentials'] },
        // Edits records and roles, without the credential admin right.
        'lower-admin': { grants: ['users:read', 'users:update', 'authz:assignments.manage'] },
        // Holds more than user-admin: user-admin does not cover it.
        'senior-admin': { grants: ['users:read', 'users:update', 'users:delete', 'users:credentials'] },
      }),
      config: { 'authz.permissions.users:credentials': {} },
    });

    userAdmin = await app.seedUser({ login: 'user-admin', roles: ['user-admin'] });
    lowerAdmin = await app.seedUser({ login: 'lower-admin', roles: ['lower-admin'] });
    protectedAdmin = await app.seedUser({ login: 'protected-admin', roles: ['admin'] });
    seniorAdmin = await app.seedUser({ login: 'senior-admin', roles: ['senior-admin'] });
  });

  after(async () => {
    await stopUsersHttpApp();
    sinon.restore();
  });

  const member = () => app.seedUser({ login: `member-${++seq}`, roles: ['member'] });
  const stored = (uuid: string) => User.query().where('Uuid', uuid).firstOrFail() as Promise<User>;

  async function unchanged(u: User): Promise<void> {
    const now = await stored(u.Uuid);
    expect(now.Email).to.eq(u.Email);
    expect(now.Login).to.eq(u.Login);
  }

  it('refuses a lower admin without users:credentials (403 forbidden) for the e-mail and for the login, and writes nothing', async () => {
    const t = await member();
    const client = await app.signIn(lowerAdmin.Uuid);

    for (const body of [{ Email: `taken-over-${seq}@evil.test` }, { Login: `taken-over-${seq}` }]) {
      const res = await client.patch(`/users/${t.Uuid}`, body);
      expect(res.status, res.text).to.eq(403);
      expect(res.body.error, res.text).to.eq('forbidden');
    }
    await unchanged(t);
  });

  it("refuses a change of a protected admin's e-mail (403 protected_role)", async () => {
    const res = await (await app.signIn(userAdmin.Uuid)).patch(`/users/${protectedAdmin.Uuid}`, { Email: 'protected-taken@evil.test' });

    expect(res.status, res.text).to.eq(403);
    expect(res.body.error).to.eq('protected_role');
    await unchanged(protectedAdmin);
  });

  it("refuses a change of a higher admin's e-mail (403 escalation)", async () => {
    const res = await (await app.signIn(userAdmin.Uuid)).patch(`/users/${seniorAdmin.Uuid}`, { Email: 'senior-taken@evil.test', Login: 'senior-taken' });

    expect(res.status, res.text).to.eq(403);
    expect(res.body.error).to.eq('escalation');
    await unchanged(seniorAdmin);
  });

  it('lets an admin holding users:credentials and covering the target change its e-mail and login', async () => {
    const t = await member();

    const res = await (await app.signIn(userAdmin.Uuid)).patch(`/users/${t.Uuid}`, { Email: `moved-${seq}@spinajs.test`, Login: `moved-${seq}` });

    expect(res.status, res.text).to.eq(200);
    const now = await stored(t.Uuid);
    expect(now.Email).to.eq(`moved-${seq}@spinajs.test`);
    expect(now.Login).to.eq(`moved-${seq}`);
  });

  it('leaves role-only changes, and an e-mail or login sent unchanged, to users:update', async () => {
    const t = await member();
    const client = await app.signIn(lowerAdmin.Uuid);

    const res = await client.patch(`/users/${t.Uuid}`, { Role: ['member', 'tag'] });
    expect(res.status, res.text).to.eq(200);
    expect((await globalRolesOf(t.Uuid)).sort()).to.deep.eq(['member', 'tag']);

    const same = await client.patch(`/users/${t.Uuid}`, { Email: t.Email, Login: t.Login, Role: ['member'] });
    expect(same.status, same.text).to.eq(200);
    expect(await globalRolesOf(t.Uuid)).to.deep.eq(['member']);
  });

  it('leaves changes of the own account to users:update', async () => {
    const res = await (await app.signIn(lowerAdmin.Uuid)).patch(`/users/${lowerAdmin.Uuid}`, { Email: 'lower-admin-new@spinajs.test' });

    expect(res.status, res.text).to.eq(200);
    expect((await stored(lowerAdmin.Uuid)).Email).to.eq('lower-admin-new@spinajs.test');
  });

  it('refuses before the role change and the uniqueness check: nothing is granted, no address is probed', async () => {
    const t = await member();
    const other = await member();
    const client = await app.signIn(lowerAdmin.Uuid);

    const res = await client.patch(`/users/${t.Uuid}`, { Email: other.Email, Role: ['member', 'tag'] });

    expect(res.status, res.text).to.eq(403);
    expect(res.body.error).to.eq('forbidden');
    expect(await globalRolesOf(t.Uuid)).to.deep.eq(['member']);
    await unchanged(t);
  });
});
