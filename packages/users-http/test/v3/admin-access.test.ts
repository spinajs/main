import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DefaultQueueService } from '@spinajs/queue';
import { User } from '@spinajs/users';

import { Users } from '../../src/admin/controllers/Users/Users.js';
import { Security } from '../../src/admin/controllers/Users/Security.js';
import { Profile } from '../../src/admin/controllers/Users/Profile.js';
import { globalRolesOf } from '../support/authz-host.js';
import { startUsersHttpApp, stopUsersHttpApp } from '../support/http-app.js';
import type { HttpClient, Res, RoleDefs, UsersHttpApp } from '../support/http-app.js';

const SERVICE_TOKEN = 'admin-svc-' + 'Pz6Hc2Qv'.repeat(4);
const UNKNOWN_UUID = '00000000-0000-4000-8000-000000000000';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/**
 * The admin record routes on `@Access('users:<action>')` (design §4.1): anonymous 401, no `users:*` grant 403, an
 * unconditional grant (users' `admin`, through `admin.users`) reaches any user. A conditional grant (`self`, or a
 * pattern) never acts on another user's row: per-row reads, updates and deletes are decided again on the row, while the
 * list, create, restore and the lifecycle routes need an unconditional decision.
 */
describe('users-http v3: admin user routes on @Access', function () {
  this.timeout(120000);

  let app: UsersHttpApp;
  let admin: User;
  let plain: User;
  let selfReader: User;
  let selfEditor: User;
  let selfCloser: User;
  let scopedCreator: User;
  let seq = 0;

  before(async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
    app = await startUsersHttpApp({
      controllers: [Users, Security, Profile],
      roles: (shipped: RoleDefs): RoleDefs => ({
        ...shipped,
        member: {},
        grantor: { grants: ['authz:assignments.manage'] },
        'self-reader': { grants: [{ permission: 'users:read', relation: 'self' }] },
        'self-editor': { grants: [{ permission: 'users:update', relation: 'self' }] },
        'self-closer': { grants: [{ permission: 'users:delete', relation: 'self' }] },
        // Conditional on the row id: allowed at type level with a residual, so it must not create.
        'scoped-creator': { grants: [{ permission: 'users:create', on: [{ type: 'users', id: 'scoped-*' }] }, 'authz:assignments.manage'] },
      }),
      config: {
        'authz.http.services': [{ name: 'admin-svc', header: 'X-Service-Token', token: SERVICE_TOKEN }],
        'authz.rbac.serviceRoles': { 'service:admin-svc': ['admin', 'grantor'] },
      },
    });

    admin = await app.seedUser({ login: 'adm', roles: ['admin', 'grantor'] });
    plain = await app.seedUser({ login: 'plain', roles: ['user'] });
    selfReader = await app.seedUser({ login: 'self-reader', roles: ['self-reader'] });
    selfEditor = await app.seedUser({ login: 'self-editor', roles: ['self-editor'] });
    selfCloser = await app.seedUser({ login: 'self-closer', roles: ['self-closer'] });
    scopedCreator = await app.seedUser({ login: 'scoped-creator', roles: ['scoped-creator'] });
  });

  after(async () => {
    await stopUsersHttpApp();
    sinon.restore();
  });

  const target = (spec: { active?: boolean } = {}) => app.seedUser({ login: `target-${++seq}`, roles: ['member'], ...spec });
  const stored = (uuid: string) => User.query().withDeleted().where('Uuid', uuid).populate('Metadata').firstOrFail() as Promise<User>;
  const service = () => ({ 'X-Service-Token': SERVICE_TOKEN });

  /** Every admin route, addressed at `t`. */
  const routes = (t: User): Array<[Method, string, unknown?]> => [
    ['GET', '/users'],
    ['GET', '/users/roles'],
    ['GET', `/users/${t.Uuid}`],
    ['GET', `/users/byLogin/${t.Login}`],
    ['POST', '/users', { Login: `new-${++seq}`, Email: `new-${seq}@spinajs.test`, Role: 'member' }],
    ['PATCH', `/users/${t.Uuid}`, { Login: `renamed-${++seq}` }],
    ['DELETE', `/users/${t.Uuid}`],
    ['PATCH', `/users/${t.Uuid}/restore`],
    ['GET', `/users/profile/${t.Login}`],
    ['POST', `/users/security/activate/${t.Uuid}`],
    ['POST', `/users/security/deactivate/${t.Uuid}`],
    ['POST', `/users/security/ban/${t.Uuid}`, { reason: 'test' }],
    ['POST', `/users/security/unban/${t.Uuid}`],
    ['GET', `/users/security/sessions/${t.Uuid}`],
    ['DELETE', `/users/security/sessions/${t.Uuid}/some-handle`],
  ];

  const send = (client: HttpClient, [method, path, body]: [Method, string, unknown?], headers: Record<string, string> = {}): Promise<Res> => client.send(method, path, body, headers);

  async function untouched(t: User): Promise<void> {
    const now = await stored(t.Uuid);
    expect(now.Login).to.eq(t.Login);
    expect(now.DeletedAt).to.not.be.ok;
    expect(now.IsActive).to.eq(true);
    expect(now.IsBanned).to.eq(false);
  }

  it('answers 401 to an anonymous request on every admin route', async () => {
    const t = await target();

    for (const route of routes(t)) {
      const res = await send(app.anonymous(), route);
      expect(res.status, `${route[0]} ${route[1]}: ${res.text}`).to.eq(401);
    }
    await untouched(t);
  });

  it("answers 403 to users' plain user role on every admin route, and changes nothing", async () => {
    const t = await target();
    const client = await app.signIn(plain.Uuid);

    for (const route of routes(t)) {
      const res = await send(client, route);
      expect(res.status, `${route[0]} ${route[1]}: ${res.text}`).to.eq(403);
    }
    await untouched(t);
  });

  describe('an admin.users holder (users:* unconditionally)', () => {
    it('lists, reads by uuid, login and profile, and lists the roles it may assign', async () => {
      const t = await target();
      const client = await app.signIn(admin.Uuid);

      const list = await client.get(`/users?pagination=${encodeURIComponent(JSON.stringify({ page: 0, limit: 100 }))}`);
      expect(list.status, list.text).to.eq(200);
      expect(list.body.map((u: { Login: string }) => u.Login)).to.include(t.Login);
      expect(list.text).to.not.contain('Password');

      const one = await client.get(`/users/${t.Uuid}`);
      expect(one.status, one.text).to.eq(200);
      expect(one.body.Uuid).to.eq(t.Uuid);
      expect(one.body.Password).to.be.undefined;

      const byLogin = await client.get(`/users/byLogin/${t.Login}`);
      expect(byLogin.status, byLogin.text).to.eq(200);
      expect(byLogin.body.Uuid).to.eq(t.Uuid);

      const profile = await client.get(`/users/profile/${t.Login}`);
      expect(profile.status, profile.text).to.eq(200);
      expect(profile.body.User.Uuid).to.eq(t.Uuid);

      const roles = await client.get('/users/roles');
      expect(roles.status, roles.text).to.eq(200);
      expect(roles.body).to.include('member');
    });

    it('answers 404 for a user that does not exist', async () => {
      const client = await app.signIn(admin.Uuid);

      expect((await client.get(`/users/${UNKNOWN_UUID}`)).status).to.eq(404);
      expect((await client.get('/users/byLogin/nobody-here')).status).to.eq(404);
      expect((await client.patch(`/users/${UNKNOWN_UUID}`, { Login: 'nobody' })).status).to.eq(404);
      expect((await client.post(`/users/security/activate/${UNKNOWN_UUID}`)).status).to.eq(404);
    });

    it('creates, updates, deletes and restores a user', async () => {
      const client = await app.signIn(admin.Uuid);

      const created = await client.post('/users', { Login: 'made-by-admin', Email: 'made-by-admin@spinajs.test', Role: 'member' });
      expect(created.status, created.text).to.eq(200);
      const made = await User.query().whereLogin('made-by-admin').firstOrFail();
      expect(await globalRolesOf(made.Uuid)).to.deep.eq(['member']);

      const t = await target();
      const patched = await client.patch(`/users/${t.Uuid}`, { Login: `${t.Login}-renamed` });
      expect(patched.status, patched.text).to.eq(200);
      expect((await stored(t.Uuid)).Login).to.eq(`${t.Login}-renamed`);

      const deleted = await client.del(`/users/${t.Uuid}`);
      expect(deleted.status, deleted.text).to.eq(200);
      expect((await stored(t.Uuid)).DeletedAt).to.be.ok;

      const restored = await client.patch(`/users/${t.Uuid}/restore`);
      expect(restored.status, restored.text).to.eq(200);
      expect((await stored(t.Uuid)).DeletedAt).to.not.be.ok;
    });

    it('deactivates, activates, bans and unbans a user', async () => {
      const client = await app.signIn(admin.Uuid);
      const t = await target();

      expect((await client.post(`/users/security/deactivate/${t.Uuid}`)).status).to.eq(200);
      expect((await stored(t.Uuid)).IsActive).to.eq(false);

      expect((await client.post(`/users/security/activate/${t.Uuid}`)).status).to.eq(200);
      expect((await stored(t.Uuid)).IsActive).to.eq(true);

      expect((await client.post(`/users/security/ban/${t.Uuid}`, { reason: 'spam', duration: 3600 })).status).to.eq(200);
      expect((await stored(t.Uuid)).IsBanned).to.eq(true);

      expect((await client.post(`/users/security/unban/${t.Uuid}`)).status).to.eq(200);
      expect((await stored(t.Uuid)).IsBanned).to.eq(false);
    });

    it('answers 404 on the 2.x credential and lockout routes, which are gone', async () => {
      const client = await app.signIn(admin.Uuid);
      const t = await target();
      const gone: Array<[Method, string, unknown?]> = [
        ['PATCH', `/users/security/changePassword/${t.Uuid}`, { password: 'Secret123!', confirmPassword: 'Secret123!' }],
        ['POST', `/users/security/password-reset-request/${t.Uuid}`],
        ['POST', `/users/security/expire-password/${t.Uuid}`],
        ['PATCH', `/users/security/reset2fa/${t.Uuid}`],
        ['POST', `/users/security/2fa/enable/${t.Uuid}`],
        ['POST', `/users/security/2fa/disable/${t.Uuid}`],
        ['POST', `/users/security/unlock/${t.Uuid}`],
      ];

      for (const route of gone) {
        const res = await send(client, route);
        expect(res.status, `${route[0]} ${route[1]}: ${res.text}`).to.eq(404);
      }
      await untouched(t);
    });
  });

  describe('a conditional users:read (self)', () => {
    it('is refused the list rather than listing everyone', async () => {
      const client = await app.signIn(selfReader.Uuid);

      const res = await client.get('/users');
      expect(res.status, res.text).to.eq(403);
      expect(res.text).to.not.contain(admin.Uuid);
      expect(res.text).to.not.contain('"Login"');
    });

    it("is refused another user's record by uuid, login and profile", async () => {
      const client = await app.signIn(selfReader.Uuid);
      const t = await target();

      for (const path of [`/users/${t.Uuid}`, `/users/byLogin/${t.Login}`, `/users/profile/${t.Login}`]) {
        const res = await client.get(path);
        expect(res.status, `${path}: ${res.text}`).to.eq(403);
        expect(res.text, path).to.not.contain(t.Email);
      }
    });

    it('is refused an unknown user the same way, so it cannot probe for accounts', async () => {
      const client = await app.signIn(selfReader.Uuid);

      expect((await client.get(`/users/${UNKNOWN_UUID}`)).status).to.eq(403);
      expect((await client.get('/users/byLogin/nobody-here')).status).to.eq(403);
      expect((await client.get('/users/profile/nobody-here')).status).to.eq(403);
    });

    it('reads its own record, decided on the row', async () => {
      const client = await app.signIn(selfReader.Uuid);

      const one = await client.get(`/users/${selfReader.Uuid}`);
      expect(one.status, one.text).to.eq(200);
      expect(one.body.Uuid).to.eq(selfReader.Uuid);

      expect((await client.get(`/users/byLogin/${selfReader.Login}`)).status).to.eq(200);
      expect((await client.get(`/users/profile/${selfReader.Login}`)).status).to.eq(200);
    });
  });

  describe('a conditional users:update (self-editor)', () => {
    it("is refused another user's record, which stays as it was", async () => {
      const client = await app.signIn(selfEditor.Uuid);
      const t = await target();

      const res = await client.patch(`/users/${t.Uuid}`, { Login: 'hijacked', Email: 'hijacked@spinajs.test' });
      expect(res.status, res.text).to.eq(403);
      await untouched(t);
    });

    it('updates its own record, decided on the row', async () => {
      const client = await app.signIn(selfEditor.Uuid);

      const res = await client.patch(`/users/${selfEditor.Uuid}`, { Email: 'self-editor-new@spinajs.test' });
      expect(res.status, res.text).to.eq(200);
      expect((await stored(selfEditor.Uuid)).Email).to.eq('self-editor-new@spinajs.test');
    });

    it('may not activate or unban anyone, itself included: those need an unconditional grant', async () => {
      const client = await app.signIn(selfEditor.Uuid);
      const t = await target({ active: false });

      for (const uuid of [t.Uuid, selfEditor.Uuid]) {
        expect((await client.post(`/users/security/activate/${uuid}`)).status, `activate ${uuid}`).to.eq(403);
        expect((await client.post(`/users/security/unban/${uuid}`)).status, `unban ${uuid}`).to.eq(403);
      }
      expect((await stored(t.Uuid)).IsActive).to.eq(false);
    });
  });

  describe('a conditional users:delete (self)', () => {
    it("is refused deleting, restoring, deactivating or banning another user, who stays in service", async () => {
      const client = await app.signIn(selfCloser.Uuid);
      const t = await target();

      expect((await client.del(`/users/${t.Uuid}`)).status).to.eq(403);
      expect((await client.post(`/users/security/deactivate/${t.Uuid}`)).status).to.eq(403);
      expect((await client.post(`/users/security/ban/${t.Uuid}`, { reason: 'x' })).status).to.eq(403);
      await untouched(t);

      const gone = await target();
      await (await stored(gone.Uuid)).destroy();
      expect((await client.patch(`/users/${gone.Uuid}/restore`)).status).to.eq(403);
      expect((await stored(gone.Uuid)).DeletedAt).to.be.ok;
    });
  });

  it('refuses a create under a conditional users:create, and creates nothing', async () => {
    const client = await app.signIn(scopedCreator.Uuid);

    const res = await client.post('/users', { Login: 'scoped-made', Email: 'scoped-made@spinajs.test', Role: 'member' });
    expect(res.status, res.text).to.eq(403);
    expect(await User.query().withDeleted().whereLogin('scoped-made').first()).to.not.exist;
  });

  describe('a service principal holding admin.users', () => {
    it('reads users', async () => {
      const t = await target();

      const res = await app.anonymous().get(`/users/${t.Uuid}`, service());
      expect(res.status, res.text).to.eq(200);
      expect(res.body.Uuid).to.eq(t.Uuid);
    });

    it('is refused the routes that act as a user actor (AuthzAdmin, account guard), and changes nothing', async () => {
      const t = await target();
      const actorRoutes: Array<[Method, string, unknown?]> = [
        ['GET', '/users/roles'],
        ['POST', '/users', { Login: 'svc-made', Email: 'svc-made@spinajs.test', Role: 'member' }],
        ['PATCH', `/users/${t.Uuid}`, { Login: 'svc-renamed' }],
        ['DELETE', `/users/${t.Uuid}`],
        ['POST', `/users/security/deactivate/${t.Uuid}`],
        ['POST', `/users/security/ban/${t.Uuid}`, { reason: 'x' }],
      ];

      for (const route of actorRoutes) {
        const res = await send(app.anonymous(), route, service());
        expect(res.status, `${route[0]} ${route[1]}: ${res.text}`).to.eq(403);
      }
      await untouched(t);
      expect(await User.query().withDeleted().whereLogin('svc-made').first()).to.not.exist;
    });
  });
});
