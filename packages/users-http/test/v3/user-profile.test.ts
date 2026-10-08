import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { DefaultQueueService } from '@spinajs/queue';
import { SessionIssuer } from '@spinajs/authn/contracts';
import { User } from '@spinajs/users';
import type { Principal } from '@spinajs/authz';

import { UserController } from '../../src/controllers/UserController.js';
import { UserMetadataController } from '../../src/controllers/UserMetadataController.js';
import { rootAuthz } from '../support/authz-host.js';
import { startUsersHttpApp, stopUsersHttpApp } from '../support/http-app.js';
import type { RoleDefs, UsersHttpApp } from '../support/http-app.js';

const PROBE_TOKEN = 'probe-' + 'Tq4Wm8Ln'.repeat(4);

/**
 * GET /user on the 3.0 stack (design §4.1.1, §11.1, B17): the caller's own record, decided on that row through the
 * `self` relation and narrowed to the fields its role reads.
 */
describe('users-http v3: GET /user', function () {
  this.timeout(60000);

  let app: UsersHttpApp;
  let me: User;
  let wide: User;
  let bystander: User;

  before(async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
    app = await startUsersHttpApp({
      controllers: [UserController, UserMetadataController],
      roles: (shipped: RoleDefs): RoleDefs => ({
        // users' shipped `user` role: user:read on self, fields Email and Login.
        user: shipped.user,
        'wide-reader': { grants: [{ permission: 'user:read', relation: 'self', fields: { read: ['*'] } }] },
        bystander: {},
        'profile-reader': { grants: ['user:read'] },
      }),
      config: {
        'authz.http.services': [{ name: 'probe', header: 'X-Probe-Token', token: PROBE_TOKEN }],
        'authz.rbac.serviceRoles': { 'service:probe': ['profile-reader'] },
      },
    });

    me = await app.seedUser({ login: 'me', email: 'me@spinajs.test', roles: ['user'], metadata: { 'user:niceName': 'Me' } });
    wide = await app.seedUser({ login: 'wide', roles: ['wide-reader'], metadata: { 'user:niceName': 'Wide', 'user:pwd_reset:token': 'reset-secret' } });
    bystander = await app.seedUser({ login: 'bystander', roles: ['bystander'] });
  });

  after(async () => {
    await stopUsersHttpApp();
    sinon.restore();
  });

  it('answers 401 to an anonymous request', async () => {
    const res = await app.anonymous().get('/user');

    expect(res.status, res.text).to.eq(401);
  });

  it("answers a signed-in user its own record, narrowed to the fields of users' user role", async () => {
    const res = await (await app.signIn(me.Uuid)).get('/user');

    expect(res.status, res.text).to.eq(200);
    expect(res.body).to.deep.eq({ Email: 'me@spinajs.test', Login: 'me' });
  });

  it('never answers Password or Id, even to a role that reads every field of its own record', async () => {
    const res = await (await app.signIn(wide.Uuid)).get('/user');

    expect(res.status, res.text).to.eq(200);
    expect(res.body.Uuid).to.eq(wide.Uuid);
    expect(res.body.Login).to.eq('wide');
    expect(res.body).to.not.have.property('Password');
    expect(res.body).to.not.have.property('Id');
  });

  it('answers the record with its metadata and ISO dates, reserved metadata left out', async () => {
    const res = await (await app.signIn(wide.Uuid)).get('/user');

    expect(res.status, res.text).to.eq(200);
    expect(res.body.CreatedAt).to.be.a('string').and.to.match(/^\d{4}-\d{2}-\d{2}T/);
    const keys = (res.body.Metadata as { Key: string }[]).map((m) => m.Key);
    expect(keys).to.include('user:niceName');
    expect(keys).to.not.include('user:pwd_reset:token');
    expect(res.text).to.not.contain('reset-secret');
  });

  it('reads the record again on every request: a change behind the session shows at once', async () => {
    const client = await app.signIn(wide.Uuid);
    expect((await client.get('/user')).body.Login).to.eq('wide');

    await User.update({ Login: 'wide-renamed' }).where({ Uuid: wide.Uuid });
    try {
      expect((await client.get('/user')).body.Login).to.eq('wide-renamed');
    } finally {
      await User.update({ Login: 'wide' }).where({ Uuid: wide.Uuid });
    }
  });

  // 2.x wrote the user's uuid back into the session on refresh; the 3.0 session keeps the identity itself (A07, A23).
  it('keeps resolving the same user on the next request with the same session', async () => {
    const client = await app.signIn(me.Uuid);

    for (let i = 0; i < 2; i++) {
      const res = await client.get('/user');
      expect(res.status, res.text).to.eq(200);
      expect(res.body.Login).to.eq('me');
    }
  });

  it('answers 403 to a signed-in user whose roles do not grant user:read', async () => {
    const res = await (await app.signIn(bystander.Uuid)).get('/user');

    expect(res.status, res.text).to.eq(403);
    expect(res.body).to.not.have.property('Login');
  });

  // An unconditional user:read is no user record: the route serves the user principal's own row only.
  it('answers 403 to a service principal, even one holding user:read', async () => {
    const probe: Principal = { type: 'service', id: 'probe', authenticated: true, source: 'service', attributes: {} };
    const held = await (await rootAuthz()).check({ principal: probe, permission: 'user:read', resource: { type: 'user', id: me.Uuid } });
    expect(held.allowed && held.residual.op === 'true', 'the probe holds an unconditional user:read').to.eq(true);

    const res = await app.anonymous().get('/user', { 'X-Probe-Token': PROBE_TOKEN });

    expect(res.status, res.text).to.eq(403);
    expect(res.body).to.not.have.property('Login');
  });

  it('answers 401 once the session is revoked', async () => {
    const client = await app.signIn(me.Uuid);
    await ((await DI.resolve(SessionIssuer)) as SessionIssuer).revoke(client.session!);

    expect((await client.get('/user')).status).to.eq(401);
  });

  describe('removed 2.x routes', () => {
    it('GET /user/grants answers 404 (GET /user/access in authz-http replaces it)', async () => {
      expect((await (await app.signIn(me.Uuid)).get('/user/grants')).status).to.eq(404);
    });

    it('PATCH /user/password answers 404 (authn-http AuthnPasswordController replaces it)', async () => {
      const res = await (await app.signIn(me.Uuid)).patch('/user/password', { OldPassword: 'current123', Password: 'changed123', ConfirmPassword: 'changed123' });

      expect(res.status, res.text).to.eq(404);
    });

    it('GET /user/refresh answers 404 (the profile is GET /user)', async () => {
      expect((await (await app.signIn(me.Uuid)).get('/user/refresh')).status).to.eq(404);
    });
  });
});
