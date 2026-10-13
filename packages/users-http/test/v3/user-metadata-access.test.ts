import 'mocha';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

import { Forbidden } from '@spinajs/exceptions';
import { DefaultQueueService } from '@spinajs/queue';
import type { Decision, Principal } from '@spinajs/authz';
import type { Request } from '@spinajs/http';
import { User, UserMetadataBase } from '@spinajs/users';

import { UserMetadataController } from '../../src/controllers/UserMetadataController.js';
import { addressedMetadata, ownMetadata } from '../../src/services/metadata-scope.js';
import { startUsersHttpApp, stopUsersHttpApp } from '../support/http-app.js';
import type { HttpClient, RoleDefs, UsersHttpApp } from '../support/http-app.js';

chai.use(chaiAsPromised);

const PROBE_TOKEN = 'probe-' + 'Mx3Rt7Kw'.repeat(4);

const entry = (Key: string, Value = 'x') => ({ Key, Value, Type: 'string' });

/**
 * The metadata routes on `@Access('user.metadata:<action>')` (design §4.1, A12): users' shipped `user` role holds
 * `user.metadata:*` through `owner`, a conditional grant that reaches only the caller's own rows; admin.users holds it
 * unconditionally and reaches any user.
 */
describe('users-http v3: metadata routes on @Access', function () {
  this.timeout(60000);

  let app: UsersHttpApp;
  let me: User;
  let other: User;
  let admin: User;
  let neither: User;
  let creator: User;

  before(async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
    app = await startUsersHttpApp({
      controllers: [UserMetadataController],
      roles: (shipped: RoleDefs): RoleDefs => ({
        ...shipped,
        bystander: {},
        // Creates on anyone, updates nothing: an upsert of an existing key must not pass as a create.
        'meta-creator': { grants: ['user.metadata:create', 'user.metadata:read'] },
        'meta-reader': { grants: ['user.metadata:read'] },
      }),
      config: {
        'authz.http.services': [{ name: 'probe', header: 'X-Probe-Token', token: PROBE_TOKEN }],
        'authz.rbac.serviceRoles': { 'service:probe': ['meta-reader'] },
      },
    });

    me = await app.seedUser({ login: 'meta-me', roles: ['user'], metadata: { 'user:niceName': 'Me' } });
    other = await app.seedUser({ login: 'meta-other', roles: ['user'], metadata: { 'user:niceName': 'Other', 'user:secret': 'do-not-touch' } });
    admin = await app.seedUser({ login: 'meta-admin', roles: ['admin'] });
    neither = await app.seedUser({ login: 'meta-neither', roles: ['bystander'], metadata: { 'user:niceName': 'Neither' } });
    creator = await app.seedUser({ login: 'meta-creator', roles: ['meta-creator'] });
  });

  after(async () => {
    await stopUsersHttpApp();
    sinon.restore();
  });

  const rowOf = (user: User, key: string) => UserMetadataBase.where({ user_id: user.Id, Key: key }).first() as Promise<UserMetadataBase | undefined>;
  const keysOf = (body: { Key: string }[]) => body.map((m) => m.Key);

  /** Every route of both families, for `user` (the addressed uuid) and an entry `row` of it. */
  const routes = (uuid: string, row: number) => [
    ['GET', `/user/metadata`],
    ['GET', `/user/metadata/user:niceName`],
    ['POST', `/user/metadata`],
    ['PATCH', `/user/metadata/user:niceName`],
    ['DELETE', `/user/metadata/${row}`],
    ['GET', `/user/${uuid}/metadata`],
    ['GET', `/user/${uuid}/metadata/user:niceName`],
    ['POST', `/user/${uuid}/metadata`],
    ['PATCH', `/user/${uuid}/metadata/user:niceName`],
    ['DELETE', `/user/${uuid}/metadata/${row}`],
  ] as const;

  const send = (client: HttpClient, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, headers: Record<string, string> = {}) => client.send(method, path, method === 'GET' || method === 'DELETE' ? undefined : entry('user:niceName', 'Changed'), headers);

  it('answers 401 to an anonymous request on every route', async () => {
    const row = (await rowOf(other, 'user:niceName'))!;

    for (const [method, path] of routes(other.Uuid, row.Id)) {
      const res = await send(app.anonymous(), method, path);
      expect(res.status, `${method} ${path}: ${res.text}`).to.eq(401);
    }
    expect((await rowOf(other, 'user:niceName'))!.Value).to.eq('Other');
  });

  it('answers 403 to a signed-in user holding no user.metadata permission, on both families', async () => {
    const client = await app.signIn(neither.Uuid);
    const row = (await rowOf(neither, 'user:niceName'))!;

    for (const [method, path] of routes(neither.Uuid, row.Id)) {
      const res = await send(client, method, path);
      expect(res.status, `${method} ${path}: ${res.text}`).to.eq(403);
    }
    expect((await rowOf(neither, 'user:niceName'))!.Value).to.eq('Neither');
  });

  describe("users' user role (user.metadata:* on its own rows only)", () => {
    it('lists, reads, adds, updates and deletes its own metadata through /user/metadata', async () => {
      const client = await app.signIn(me.Uuid);

      const list = await client.get('/user/metadata');
      expect(list.status, list.text).to.eq(200);
      expect(keysOf(list.body)).to.deep.eq(['user:niceName']);

      const one = await client.get('/user/metadata/user:niceName');
      expect(one.status, one.text).to.eq(200);
      expect(one.body.Value).to.eq('Me');

      expect((await client.post('/user/metadata', entry('user:avatar', 'a.png'))).status).to.eq(200);
      expect((await rowOf(me, 'user:avatar'))!.Value).to.eq('a.png');

      expect((await client.patch('/user/metadata/user:avatar', entry('user:avatar', 'b.png'))).status).to.eq(200);
      expect((await rowOf(me, 'user:avatar'))!.Value).to.eq('b.png');

      const avatar = (await rowOf(me, 'user:avatar'))!;
      expect((await client.del(`/user/metadata/${avatar.Id}`)).status).to.eq(200);
      expect(await rowOf(me, 'user:avatar')).to.not.exist;
    });

    it("is refused another user's metadata on every route of /user/:uuid/metadata, and changes nothing", async () => {
      const client = await app.signIn(me.Uuid);
      const secret = (await rowOf(other, 'user:secret'))!;

      const list = await client.get(`/user/${other.Uuid}/metadata`);
      expect(list.status, list.text).to.eq(403);
      expect(list.text).to.not.contain('do-not-touch');

      const one = await client.get(`/user/${other.Uuid}/metadata/user:secret`);
      expect(one.status, one.text).to.eq(403);
      expect(one.text).to.not.contain('do-not-touch');

      expect((await client.post(`/user/${other.Uuid}/metadata`, entry('user:planted'))).status).to.eq(403);
      expect((await client.post(`/user/${other.Uuid}/metadata`, entry('user:secret', 'hacked'))).status).to.eq(403);
      expect((await client.patch(`/user/${other.Uuid}/metadata/user:secret`, entry('user:secret', 'hacked'))).status).to.eq(403);
      expect((await client.patch(`/user/${other.Uuid}/metadata/${secret.Id}`, entry('user:secret', 'hacked'))).status).to.eq(403);
      expect((await client.del(`/user/${other.Uuid}/metadata/${secret.Id}`)).status).to.eq(403);

      expect((await rowOf(other, 'user:secret'))!.Value).to.eq('do-not-touch');
      expect(await rowOf(other, 'user:planted')).to.not.exist;
    });

    it("is refused an unknown user's metadata the same way, so the route tells no account apart", async () => {
      const client = await app.signIn(me.Uuid);

      const res = await client.get('/user/00000000-0000-4000-8000-000000000000/metadata');
      expect(res.status, res.text).to.eq(403);
    });

    it("cannot reach another user's row through its own family by id or key", async () => {
      const client = await app.signIn(me.Uuid);
      const secret = (await rowOf(other, 'user:secret'))!;

      expect((await client.get('/user/metadata/user:secret')).status).to.eq(404);
      expect((await client.patch(`/user/metadata/${secret.Id}`, entry('user:secret', 'hacked'))).status).to.eq(404);
      expect((await client.del(`/user/metadata/${secret.Id}`)).status).to.eq(404);

      expect((await rowOf(other, 'user:secret'))!.Value).to.eq('do-not-touch');
    });

    it('may address its own uuid on /user/:uuid/metadata, with the same per-row decision', async () => {
      const client = await app.signIn(me.Uuid);

      const list = await client.get(`/user/${me.Uuid}/metadata`);
      expect(list.status, list.text).to.eq(200);
      expect(keysOf(list.body)).to.deep.eq(['user:niceName']);

      expect((await client.post(`/user/${me.Uuid}/metadata`, entry('user:theme', 'dark'))).status).to.eq(200);
      const theme = (await rowOf(me, 'user:theme'))!;
      expect((await client.del(`/user/${me.Uuid}/metadata/${theme.Id}`)).status).to.eq(200);
      expect(await rowOf(me, 'user:theme')).to.not.exist;
    });
  });

  describe('an admin.users holder (user.metadata:* unconditionally)', () => {
    it("lists, reads, adds, updates and deletes any user's metadata", async () => {
      const client = await app.signIn(admin.Uuid);

      const list = await client.get(`/user/${other.Uuid}/metadata`);
      expect(list.status, list.text).to.eq(200);
      expect(keysOf(list.body)).to.have.members(['user:niceName', 'user:secret']);

      const one = await client.get(`/user/${other.Uuid}/metadata/user:secret`);
      expect(one.status, one.text).to.eq(200);
      expect(one.body.Value).to.eq('do-not-touch');

      expect((await client.post(`/user/${other.Uuid}/metadata`, entry('admin:note', 'checked'))).status).to.eq(200);
      expect((await rowOf(other, 'admin:note'))!.Value).to.eq('checked');

      expect((await client.patch(`/user/${other.Uuid}/metadata/admin:note`, entry('admin:note', 'reviewed'))).status).to.eq(200);
      expect((await rowOf(other, 'admin:note'))!.Value).to.eq('reviewed');

      const note = (await rowOf(other, 'admin:note'))!;
      expect((await client.del(`/user/${other.Uuid}/metadata/${note.Id}`)).status).to.eq(200);
      expect(await rowOf(other, 'admin:note')).to.not.exist;
    });

    it('answers 404 for a user that does not exist', async () => {
      const res = await (await app.signIn(admin.Uuid)).get('/user/00000000-0000-4000-8000-000000000000/metadata');

      expect(res.status, res.text).to.eq(404);
    });
  });

  describe('the scope a route decision gives the service', () => {
    const principalOf = (user: User): Principal => ({ type: 'user', id: user.Uuid, authenticated: true, source: 'session', attributes: {} });
    const requestOf = (user: User, decision: Partial<Decision> | undefined): Request => ({ storage: { Principal: principalOf(user), ...(decision ? { AuthzDecision: decision } : {}) } }) as unknown as Request;
    const owner: Partial<Decision> = { allowed: true, permission: 'user.metadata:read', residual: { op: 'relation', relation: 'owner' } as Decision['residual'] };
    const unconditional: Partial<Decision> = { allowed: true, permission: 'user.metadata:read', residual: { op: 'true' } as Decision['residual'] };

    it('decides a conditional decision again on each row, as the caller', async () => {
      const scope = ownMetadata(requestOf(me, owner), me);

      expect(scope.ownerId).to.eq(me.Id);
      expect(await scope.admits('user.metadata:read', (await rowOf(me, 'user:niceName'))!)).to.eq(true);
      expect(await scope.admits('user.metadata:read', (await rowOf(other, 'user:secret'))!), "another user's row").to.eq(false);
    });

    it('lets an unconditional decision through for its own permission only', async () => {
      const scope = ownMetadata(requestOf(neither, unconditional), neither);

      expect(await scope.admits('user.metadata:read', (await rowOf(other, 'user:secret'))!)).to.eq(true);
      expect(await scope.admits('user.metadata:delete', (await rowOf(other, 'user:secret'))!), 'neither holds delete').to.eq(false);
    });

    it("addresses another user's metadata with an unconditional decision only", async () => {
      expect((await addressedMetadata(requestOf(me, unconditional), other.Uuid)).ownerId).to.eq(other.Id);
      expect((await addressedMetadata(requestOf(me, owner), me.Uuid)).ownerId).to.eq(me.Id);
      await expect(addressedMetadata(requestOf(me, owner), other.Uuid)).to.be.rejectedWith(Forbidden);
    });

    it('serves nothing without an allowing route decision', async () => {
      expect(() => ownMetadata(requestOf(me, undefined), me)).to.throw(Forbidden);
      expect(() => ownMetadata(requestOf(me, { ...unconditional, allowed: false }), me)).to.throw(Forbidden);
      await expect(addressedMetadata(requestOf(me, undefined), me.Uuid)).to.be.rejectedWith(Forbidden);
    });
  });

  describe('other principals and grants', () => {
    it('serves no own family to a service principal, and the admin family as far as its unconditional grant goes', async () => {
      const probe = { 'X-Probe-Token': PROBE_TOKEN };

      expect((await app.anonymous().get('/user/metadata', probe)).status).to.eq(403);

      const list = await app.anonymous().get(`/user/${other.Uuid}/metadata`, probe);
      expect(list.status, list.text).to.eq(200);
      expect(keysOf(list.body)).to.include('user:secret');

      expect((await app.anonymous().post(`/user/${other.Uuid}/metadata`, entry('user:probe'), probe)).status).to.eq(403);
      expect(await rowOf(other, 'user:probe')).to.not.exist;
    });

    it('an upsert of an existing key needs user.metadata:update too, not only create', async () => {
      const client = await app.signIn(creator.Uuid);

      expect((await client.post(`/user/${other.Uuid}/metadata`, entry('user:created', 'new'))).status).to.eq(200);
      expect((await rowOf(other, 'user:created'))!.Value).to.eq('new');

      const res = await client.post(`/user/${other.Uuid}/metadata`, entry('user:secret', 'hacked'));
      expect(res.status, res.text).to.eq(403);
      expect((await rowOf(other, 'user:secret'))!.Value).to.eq('do-not-touch');
    });
  });
});
