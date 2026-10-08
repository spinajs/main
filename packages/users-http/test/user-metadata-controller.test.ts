import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { randomUUID } from 'node:crypto';

import { DefaultQueueService } from '@spinajs/queue';
import { SortOrder } from '@spinajs/orm';
import { FilterableLogicalOperators } from '@spinajs/orm-http';
import { USER_COMMON_METADATA, User, UserMetadataBase } from '@spinajs/users';

import { UserMetadataController } from '../src/controllers/UserMetadataController.js';
import { startUsersHttpApp, stopUsersHttpApp } from './support/http-app.js';
import type { HttpClient, Res, UsersHttpApp } from './support/http-app.js';

/**
 * The user metadata routes through a running app: the own family (`/user/metadata`) as the owner, a
 * user holding users' `user` role, and the uuid family (`/user/:uuid/metadata`) as an admin holding
 * users' `admin` role. What is exercised here is the query logic itself — most importantly the owner
 * scoping of the routes — and the reserved-key guard.
 */

/** A query string of JSON-encoded route args (`pagination`, `order`, `filter`). */
const q = (args: Record<string, unknown>) => `?${Object.entries(args).map(([k, v]) => `${k}=${encodeURIComponent(JSON.stringify(v))}`).join('&')}`;

const keysOf = (res: Res) => (res.body as { Key: string }[]).map((m) => m.Key);

/** A write body: Value travels as a string, Type says what it is. */
const dto = (Key: string, Value: unknown, Type = 'string') => ({ Key, Value: String(Value), Type });

describe('UserMetadataController', function () {
  this.timeout(60000);

  let app: UsersHttpApp;
  let admin: HttpClient;
  let client: HttpClient;
  let owner: User;
  let other: User;

  before(async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));
    app = await startUsersHttpApp({ controllers: [UserMetadataController] });
    admin = await app.signIn((await app.seedUser({ login: `meta-admin-${randomUUID()}`, roles: ['admin'] })).Uuid);
  });

  after(async () => {
    await stopUsersHttpApp();
    sinon.restore();
  });

  // Fresh accounts per case: the cases write and delete their metadata.
  beforeEach(async () => {
    owner = await app.seedUser({ login: `owner-${randomUUID()}`, roles: ['user'], metadata: { 'user:niceName': 'Owner', 'user:phone': '111222333' } });
    other = await app.seedUser({ login: `other-${randomUUID()}`, roles: ['user'], metadata: { 'user:niceName': 'Other', secret: 'do-not-touch' } });
    client = await app.signIn(owner.Uuid);
  });

  const metaOf = (user: User, key: string) => UserMetadataBase.where({ user_id: user.Id, Key: key }).first() as Promise<UserMetadataBase | undefined>;
  const allMetaOf = (user: User) => UserMetadataBase.where({ user_id: user.Id }) as any as Promise<UserMetadataBase[]>;
  const of = (user: User) => `/user/${user.Uuid}/metadata`;

  describe('own metadata — read', () => {
    it('lists the metadata of the authenticated user', async () => {
      const res = await client.get('/user/metadata');

      expect(res.status, res.text).to.eq(200);
      expect(keysOf(res)).to.have.members(['user:niceName', 'user:phone']);
    });

    it('never lists metadata belonging to somebody else', async () => {
      expect(keysOf(await client.get('/user/metadata'))).to.not.include('secret');
    });

    it('lists metadata when no pagination is supplied', async () => {
      // A plain GET /user/metadata carries no query string, so `pagination`
      // arrives empty. `take(0)` is rejected by the query builder, so the
      // handler has to fall back to a sane page size instead of forwarding 0.
      const res = await client.get(`/user/metadata${q({ pagination: {} })}`);

      expect(res.status, res.text).to.eq(200);
      expect(res.body).to.have.lengthOf(2);
    });

    it('paginates', async () => {
      const page0 = (await client.get(`/user/metadata${q({ pagination: { page: 0, limit: 1 } })}`)).body;
      const page1 = (await client.get(`/user/metadata${q({ pagination: { page: 1, limit: 1 } })}`)).body;

      expect(page0).to.have.lengthOf(1);
      expect(page1).to.have.lengthOf(1);
      expect(page0[0].Key).to.not.eq(page1[0].Key);
    });

    it('orders by the requested column', async () => {
      const asc = await client.get(`/user/metadata${q({ pagination: { page: 0, limit: 10 }, order: { column: 'Key', order: SortOrder.ASC } })}`);

      expect(keysOf(asc)).to.deep.eq(['user:niceName', 'user:phone']);
    });

    it('returns a single own entry by key', async () => {
      expect((await client.get('/user/metadata/user:niceName')).body.Value).to.eq('Owner');
    });

    it('does not return another user entry by key', async () => {
      expect((await client.get('/user/metadata/secret')).status).to.eq(404);
    });
  });

  describe('own metadata — write', () => {
    it('adds a new entry', async () => {
      const res = await client.post('/user/metadata', dto('user:avatar', 'a.png'));

      expect(res.status, res.text).to.eq(200);
      expect((await metaOf(owner, 'user:avatar'))!.Value).to.eq('a.png');
    });

    it('forces ownership — a user_id sent in the payload is ignored', async () => {
      await client.post('/user/metadata', { ...dto('user:injected', 'x'), user_id: other.Id });

      expect(await metaOf(owner, 'user:injected'), 'entry must land on the caller').to.exist;
      expect(await metaOf(other, 'user:injected'), 'entry must not land on the spoofed user').to.not.exist;
    });

    it('updates an existing entry by key', async () => {
      await client.patch('/user/metadata/user:niceName', dto('user:niceName', 'Renamed'));

      expect((await metaOf(owner, 'user:niceName'))!.Value).to.eq('Renamed');
    });

    it('updates an existing entry by id', async () => {
      const entry = await metaOf(owner, 'user:phone');

      await client.patch(`/user/metadata/${entry!.Id}`, dto('user:phone', '999'));

      expect((await metaOf(owner, 'user:phone'))!.Value).to.eq('999');
    });

    /**
     * The Id/Key lookup addresses ONE column, chosen by the identifier's shape.
     *
     * The decoy is the point: an entry whose KEY is the digits of another entry's ID. The previous
     * `Key = ? OR Id = ?` matched both rows at once wherever the database coerces a number against
     * a varchar (and on MySQL refused the UPDATE outright with `ER_TRUNCATED_WRONG_VALUE`, which is
     * how the defect surfaced — every id-addressed update answered a 500).
     */
    it('updates by id without touching an entry whose key is that number', async () => {
      const phone = await metaOf(owner, 'user:phone');

      // Inserted directly rather than through the relation proxy: the decoy's key is a number, and
      // the proxy indexes entries by key, so a numeric one collides with its own array handling.
      const decoy = new UserMetadataBase();
      decoy.Key = String(phone!.Id);
      decoy.Value = 'decoy';
      decoy.Type = 'string';
      decoy.user_id = owner.Id;
      await decoy.insert();

      await client.patch(`/user/metadata/${phone!.Id}`, dto('user:phone', '999'));

      expect((await metaOf(owner, 'user:phone'))!.Value, 'the addressed entry').to.eq('999');
      expect((await metaOf(owner, String(phone!.Id)))!.Value, 'an entry whose key merely looks like that id must be left alone').to.eq('decoy');
    });

    it('cannot update an entry of another user by key', async () => {
      expect((await client.patch('/user/metadata/secret', dto('secret', 'hacked'))).status).to.eq(404);

      expect((await metaOf(other, 'secret'))!.Value, 'foreign metadata must stay untouched').to.eq('do-not-touch');
    });

    it('cannot update an entry of another user by id', async () => {
      const foreign = await metaOf(other, 'secret');

      expect((await client.patch(`/user/metadata/${foreign!.Id}`, dto('secret', 'hacked'))).status).to.eq(404);

      expect((await metaOf(other, 'secret'))!.Value).to.eq('do-not-touch');
    });

    it('deletes an own entry', async () => {
      const entry = await metaOf(owner, 'user:phone');

      const res = await client.del(`/user/metadata/${entry!.Id}`);

      expect(res.status, res.text).to.eq(200);
      expect(await metaOf(owner, 'user:phone')).to.not.exist;
    });

    it('cannot delete an entry of another user', async () => {
      const foreign = await metaOf(other, 'secret');

      expect((await client.del(`/user/metadata/${foreign!.Id}`)).status).to.eq(404);

      expect(await metaOf(other, 'secret'), 'foreign metadata must survive').to.exist;
    });
  });

  describe('protected metadata keys', () => {
    it('refuses to plant the invite marker through own POST /user/metadata', async () => {
      expect((await client.post('/user/metadata', dto(USER_COMMON_METADATA.USER_INVITE_PENDING, true, 'boolean'))).status).to.eq(400);

      expect(await metaOf(owner, USER_COMMON_METADATA.USER_INVITE_PENDING)).to.not.exist;
    });

    it('refuses to rewrite an entry Key to the invite marker through own PATCH', async () => {
      expect((await client.patch('/user/metadata/user:niceName', dto(USER_COMMON_METADATA.USER_INVITE_PENDING, true, 'boolean'))).status).to.eq(400);

      expect((await metaOf(owner, 'user:niceName'))!.Value, 'the original entry must be untouched').to.eq('Owner');
      expect(await metaOf(owner, USER_COMMON_METADATA.USER_INVITE_PENDING)).to.not.exist;
    });

    it('refuses to plant the invite marker through the admin route', async () => {
      expect((await admin.post(of(other), dto(USER_COMMON_METADATA.USER_INVITE_PENDING, true, 'boolean'))).status).to.eq(400);

      expect(await metaOf(other, USER_COMMON_METADATA.USER_INVITE_PENDING)).to.not.exist;
    });

    it('still allows an ordinary key through the generic write API', async () => {
      const res = await client.post('/user/metadata', dto('user:niceName', 'Still Owner'));

      expect(res.status, res.text).to.eq(200);
      expect((await metaOf(owner, 'user:niceName'))!.Value).to.eq('Still Owner');
    });
  });

  describe('admin routes', () => {
    it('lists the metadata of any user', async () => {
      const res = await admin.get(`${of(other)}${q({ pagination: { page: 0, limit: 10 } })}`);

      expect(res.status, res.text).to.eq(200);
      expect(keysOf(res)).to.have.members(['user:niceName', 'secret']);
    });

    it('lists the metadata of any user when no pagination is supplied', async () => {
      expect((await admin.get(`${of(other)}${q({ pagination: {} })}`)).body).to.have.lengthOf(2);
    });

    it('returns a single entry of any user by key', async () => {
      expect((await admin.get(`${of(other)}/secret`)).body.Value).to.eq('do-not-touch');
    });

    it('adds metadata to any user', async () => {
      const res = await admin.post(of(other), dto('admin:note', 'checked'));

      expect(res.status, res.text).to.eq(200);
      expect((await metaOf(other, 'admin:note'))!.Value).to.eq('checked');
    });

    it('updates metadata of any user, scoped to that user', async () => {
      const entry = await metaOf(other, 'secret');

      await admin.patch(`${of(other)}/${entry!.Id}`, dto('secret', 'reviewed'));

      expect((await metaOf(other, 'secret'))!.Value).to.eq('reviewed');
      expect((await metaOf(owner, 'user:niceName'))!.Value, 'other accounts must be untouched').to.eq('Owner');
    });

    it('deletes metadata of any user', async () => {
      const entry = await metaOf(other, 'secret');

      const res = await admin.del(`${of(other)}/${entry!.Id}`);

      expect(res.status, res.text).to.eq(200);
      expect(await metaOf(other, 'secret')).to.not.exist;
    });

    it('does not delete an entry that belongs to a different user than the one addressed', async () => {
      const ownerEntry = await metaOf(owner, 'user:phone');

      expect((await admin.del(`${of(other)}/${ownerEntry!.Id}`)).status).to.eq(404);

      expect(await metaOf(owner, 'user:phone'), 'delete must stay scoped to the addressed user').to.exist;
    });

    it('leaves the rest of the metadata of the user alone when one entry is removed', async () => {
      const entry = await metaOf(other, 'secret');
      await admin.del(`${of(other)}/${entry!.Id}`);

      const left = await allMetaOf(other);
      expect(left.map((m) => m.Key)).to.deep.eq(['user:niceName']);
    });

    it('answers 404 for an update of an entry that does not exist', async () => {
      expect((await client.patch('/user/metadata/user:missing', dto('user:missing', 'x'))).status).to.eq(404);
      expect(await metaOf(owner, 'user:missing')).to.not.exist;
    });

    it('answers 404 for a delete of an entry that does not exist', async () => {
      expect((await admin.del(`${of(other)}/999999`)).status).to.eq(404);
    });
  });

  /**
   * Reserved keys (A12: `2fa:`, `user:2fa:`, `user:pwd_reset:`, `user:pwd:`, `user:login:`,
   * `user:ban:`, `user:invite:`) behave as absent on every metadata route: hidden from lists,
   * 404 when addressed, refused as a write target.
   */
  describe('reserved metadata keys', () => {
    const plant = async (user: User, key: string, value: unknown) => {
      // straight insert: the guard-free path authn and the user actions write through
      const m = new UserMetadataBase();
      m.Key = key;
      m.Value = value;
      m.user_id = user.Id;
      await m.insert();
      return (await metaOf(user, key))!;
    };

    const own = (key: string) => `/user/metadata/${encodeURIComponent(key)}`;

    describe('own routes', () => {
      beforeEach(async () => {
        await plant(owner, '2fa:token', 'JBSWY3DPEHPK3PXP');
        await plant(owner, '2fa:enabled', true);
        await plant(owner, 'user:pwd_reset:token', 'reset-token');
        await plant(owner, 'user:invite:pending', true);
      });

      it('lists no reserved key', async () => {
        expect(keysOf(await client.get(`/user/metadata${q({ pagination: { page: 0, limit: 50 } })}`))).to.have.members(['user:niceName', 'user:phone']);
      });

      it('fills a page with visible entries only', async () => {
        // reserved rows have the highest ids, so they would lead a DESC page if filtered after the query
        const page = keysOf(await client.get(`/user/metadata${q({ pagination: { page: 0, limit: 2 } })}`));

        expect(page).to.have.members(['user:niceName', 'user:phone']);
      });

      it('lists no reserved key under a client filter that targets them', async () => {
        const filter = {
          op: FilterableLogicalOperators.Or,
          filters: [
            { Column: 'Key', Operator: 'like', Value: '2fa' },
            { Column: 'Key', Operator: 'like', Value: 'pwd_reset' },
          ],
        };

        const res = await client.get(`/user/metadata${q({ pagination: { page: 0, limit: 50 }, filter })}`);
        expect(res.status, res.text).to.eq(200);
        expect(keysOf(res)).to.deep.eq([]);
      });

      it('lists no reserved key stored in a width variant', async () => {
        await plant(owner, '２fa:otp', '123456');

        expect(keysOf(await client.get(`/user/metadata${q({ pagination: { page: 0, limit: 50 } })}`))).to.have.members(['user:niceName', 'user:phone']);
      });

      for (const key of ['2fa:token', '2fa:enabled', 'user:pwd_reset:token', 'user:invite:pending', '2FA:TOKEN', '２fa:token']) {
        it(`answers 404 for a read of ${key}`, async () => {
          expect((await client.get(own(key))).status).to.eq(404);
        });
      }

      it('answers 404 for a read of a key that does not exist', async () => {
        expect((await client.get(own('user:missing'))).status).to.eq(404);
      });

      it('refuses a write of a reserved key and keeps the stored value', async () => {
        expect((await client.post('/user/metadata', dto('2fa:enabled', false, 'boolean'))).status).to.eq(400);

        expect((await metaOf(owner, '2fa:enabled'))!.Value).to.eq(true);
      });

      it('answers 404 for an update addressed by a reserved key', async () => {
        expect((await client.patch(own('2fa:token'), dto('user:avatar', 'x'))).status).to.eq(404);

        expect((await metaOf(owner, '2fa:token'))!.Value).to.eq('JBSWY3DPEHPK3PXP');
      });

      it('answers 404 for an update addressed by the id of a reserved row', async () => {
        const row = await metaOf(owner, 'user:pwd_reset:token');

        expect((await client.patch(`/user/metadata/${row!.Id}`, dto('user:avatar', 'x'))).status).to.eq(404);

        const after = await metaOf(owner, 'user:pwd_reset:token');
        expect(after!.Value).to.eq('reset-token');
      });

      it('refuses to rename a plain entry to a reserved key in any case', async () => {
        expect((await client.patch('/user/metadata/user:niceName', dto('2FA:Enabled', false, 'boolean'))).status).to.eq(400);

        expect((await metaOf(owner, 'user:niceName'))!.Value).to.eq('Owner');
      });

      it('answers 404 for a delete of a reserved row and keeps it', async () => {
        const row = await metaOf(owner, '2fa:enabled');

        expect((await client.del(`/user/metadata/${row!.Id}`)).status).to.eq(404);

        expect(await metaOf(owner, '2fa:enabled')).to.exist;
      });

      it('still reads, updates and deletes plain entries', async () => {
        expect((await client.get('/user/metadata/user:phone')).body.Value).to.eq('111222333');

        await client.patch('/user/metadata/user:phone', dto('user:phone', '444'));
        expect((await metaOf(owner, 'user:phone'))!.Value).to.eq('444');

        const phone = await metaOf(owner, 'user:phone');
        await client.del(`/user/metadata/${phone!.Id}`);
        expect(await metaOf(owner, 'user:phone')).to.not.exist;
      });
    });

    describe('admin routes', () => {
      beforeEach(async () => {
        await plant(other, 'user:pwd_reset:token', 'reset-token');
        await plant(other, 'user:2fa:token', 'legacy');
        await plant(other, 'user:ban:is_banned', false);
        await plant(other, 'user:login:attempts', '2');
      });

      it('lists no reserved key of another user', async () => {
        expect(keysOf(await admin.get(`${of(other)}${q({ pagination: { page: 0, limit: 50 } })}`))).to.have.members(['user:niceName', 'secret']);
      });

      for (const key of ['user:pwd_reset:token', 'user:2fa:token', 'user:ban:is_banned', 'user:login:attempts', 'User:Pwd_Reset:Token']) {
        it(`answers 404 for a read of ${key}`, async () => {
          expect((await admin.get(`${of(other)}/${encodeURIComponent(key)}`)).status).to.eq(404);
        });
      }

      it('refuses to plant a known 2fa secret', async () => {
        expect((await admin.post(of(other), dto('2fa:token', 'KNOWNSECRET'))).status).to.eq(400);

        expect(await metaOf(other, '2fa:token')).to.not.exist;
      });

      it('answers 404 for an update of a reserved row', async () => {
        const row = await metaOf(other, 'user:ban:is_banned');

        expect((await admin.patch(`${of(other)}/${row!.Id}`, dto('user:avatar', 'x'))).status).to.eq(404);

        expect((await metaOf(other, 'user:ban:is_banned'))!.Value).to.eq(false);
      });

      it('answers an update of a reserved entry exactly like one of a missing entry', async () => {
        const row = await metaOf(other, 'user:pwd_reset:token');
        const failure = async (meta: string, key = 'user:avatar') => {
          const res = await admin.patch(`${of(other)}/${encodeURIComponent(meta)}`, dto(key, 'x'));
          expect(res.status, 'the update went through').to.not.eq(200);
          return { status: res.status, message: res.body?.message };
        };

        const missing = await failure('999999');
        expect(missing.status).to.eq(404);
        expect(await failure(String(row!.Id))).to.deep.eq(missing);
        expect(await failure('user:pwd_reset:token')).to.deep.eq(await failure('user:missing'));

        // a reserved body key is refused before any lookup, whether the entry exists or not
        expect(await failure(String(row!.Id), '2fa:token')).to.deep.eq(await failure('999999', '2fa:token'));
      });

      it('answers 404 for a delete of a reserved row and keeps it', async () => {
        const row = await metaOf(other, 'user:2fa:token');

        expect((await admin.del(`${of(other)}/${row!.Id}`)).status).to.eq(404);

        expect(await metaOf(other, 'user:2fa:token')).to.exist;
      });
    });

    /**
     * MySQL's default collations match spellings the key check cannot foresee to a stored key.
     * SQLite compares bytes, so a stub makes `kit:twin` address the owner's `2fa:enabled` row.
     */
    describe('collation twins', () => {
      let stub: sinon.SinonStub;

      beforeEach(async () => {
        await plant(owner, '2fa:enabled', true);

        const where = UserMetadataBase.where.bind(UserMetadataBase) as (...args: any[]) => any;
        const twin = Object.assign(new UserMetadataBase(), { Key: '2fa:enabled', user_id: owner.Id });
        stub = sinon.stub(UserMetadataBase, 'where').callsFake(((...args: any[]) => (args[0] === 'Key' && args[1] === 'kit:twin' ? { andWhere: async () => [twin] } : where(...args))) as any);
      });

      afterEach(() => {
        stub.restore();
      });

      it('refuses a write whose key addresses a reserved row', async () => {
        expect((await client.post('/user/metadata', dto('kit:twin', false, 'boolean'))).status).to.eq(400);
        expect((await admin.post(of(owner), dto('kit:twin', false, 'boolean'))).status).to.eq(400);

        expect(await metaOf(owner, 'kit:twin')).to.not.exist;
      });

      it('refuses to rename an entry to a key that addresses a reserved row', async () => {
        expect((await client.patch('/user/metadata/user:niceName', dto('kit:twin', 'x'))).status).to.eq(400);

        expect((await metaOf(owner, 'user:niceName'))!.Value).to.eq('Owner');
      });

      it('answers 404 for a read whose key addresses a reserved row', async () => {
        expect((await client.get('/user/metadata/kit:twin')).status).to.eq(404);
        expect((await client.patch('/user/metadata/kit:twin', dto('user:avatar', 'x'))).status).to.eq(404);
      });
    });
  });
});
