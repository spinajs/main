import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm, SortOrder } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { DefaultQueueService } from '@spinajs/queue';
import { Ok } from '@spinajs/http';
import { FilterableLogicalOperators, OrderDTO, PaginationDTO } from '@spinajs/orm-http';

import { InvalidArgument, ResourceNotFound } from '@spinajs/exceptions';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, USER_COMMON_METADATA, User, UserMetadata } from '@spinajs/users';

import { UserMetadataController } from '../src/controllers/UserMetadataController.js';
import { DbTestConfiguration } from './db-common.js';

/**
 * Database backed tests for the user metadata controller.
 *
 * Handlers are called directly with the arguments the http layer would have
 * produced (@User / @FromModel resolve to models, @AsModel to a hydrated
 * UserMetadata), so what is exercised here is the query logic itself — most
 * importantly the owner scoping of the "own" routes.
 */

const body = async <T = any>(r: any): Promise<T> => await r.responseData;

describe('UserMetadataController', function () {
  this.timeout(25000);

  const OWNER_UUID = 'dddddddd-1111-4111-8111-dddddddddddd';
  const OTHER_UUID = 'eeeeeeee-2222-4222-8222-eeeeeeeeeeee';

  let controller: UserMetadataController;
  let owner: User;
  let other: User;

  before(() => {
    DI.setESMModuleSupport();
  });

  beforeEach(async () => {
    // sibling suites in this package leave their own Configuration / providers
    // resolved in the container; start from a clean cache so this suite runs
    // against its own wiring regardless of file order
    DI.clearCache();

    DI.register(DbTestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    DI.register(SimpleDbAuthProvider).as(AuthProvider);

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration);
    await DI.resolve(Orm);

    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    controller = await DI.resolve(UserMetadataController);

    await seed();
  });

  // the admin suites that run after this file bring their own Configuration; the
  // container hands out the last registered one
  after(() => {
    DI.unregister(DbTestConfiguration);
  });

  afterEach(async () => {
    sinon.restore();
    DI.clearCache();
  });

  async function seed() {
    const pwd = DI.resolve(BasicPasswordProvider);

    owner = new User({
      Uuid: OWNER_UUID,
      Email: 'owner@spinajs.pl',
      Login: 'owner',
      Password: await pwd.hash('owner1234'),
      Role: ['user'],
      IsActive: true,
    });
    await owner.insert();
    owner.Metadata['user:niceName'] = 'Owner';
    owner.Metadata['user:phone'] = '111222333';
    await owner.Metadata.sync();

    other = new User({
      Uuid: OTHER_UUID,
      Email: 'other@spinajs.pl',
      Login: 'other',
      Password: await pwd.hash('other1234'),
      Role: ['user'],
      IsActive: true,
    });
    await other.insert();
    other.Metadata['user:niceName'] = 'Other';
    other.Metadata['secret'] = 'do-not-touch';
    await other.Metadata.sync();
  }

  const metaOf = (user: User, key: string) => UserMetadata.where({ user_id: user.Id, Key: key }).first();
  const allMetaOf = (user: User) => UserMetadata.where({ user_id: user.Id }) as any as Promise<UserMetadata[]>;

  describe('own metadata — read', () => {
    it('lists the metadata of the authenticated user', async () => {
      const result = await controller.readMeta(owner);
      const data = await body<any[]>(result);

      expect(result).to.be.instanceOf(Ok);
      expect(data.map((m) => m.Key)).to.have.members(['user:niceName', 'user:phone']);
    });

    it('never lists metadata belonging to somebody else', async () => {
      const data = await body<any[]>(await controller.readMeta(owner));

      expect(data.map((m) => m.Key)).to.not.include('secret');
    });

    it('lists metadata when no pagination is supplied', async () => {
      // A plain GET /user/metadata carries no query string, so `pagination`
      // arrives empty. `take(0)` is rejected by the query builder, so the
      // handler has to fall back to a sane page size instead of forwarding 0.
      const data = await body<any[]>(await controller.readMeta(owner, new PaginationDTO({})));

      expect(data).to.have.lengthOf(2);
    });

    it('paginates', async () => {
      const page0 = await body<any[]>(await controller.readMeta(owner, new PaginationDTO({ page: 0, limit: 1 })));
      const page1 = await body<any[]>(await controller.readMeta(owner, new PaginationDTO({ page: 1, limit: 1 })));

      expect(page0).to.have.lengthOf(1);
      expect(page1).to.have.lengthOf(1);
      expect(page0[0].Key).to.not.eq(page1[0].Key);
    });

    it('orders by the requested column', async () => {
      const asc = await body<any[]>(await controller.readMeta(owner, new PaginationDTO({ page: 0, limit: 10 }), new OrderDTO({ column: 'Key', order: SortOrder.ASC })));

      expect(asc.map((m) => m.Key)).to.deep.eq(['user:niceName', 'user:phone']);
    });

    it('returns a single own entry by key', async () => {
      const data = await body<any>(await controller.getMeta(owner, 'user:niceName'));

      expect(data.Value).to.eq('Owner');
    });

    it('does not return another user entry by key', async () => {
      await expect(controller.getMeta(owner, 'secret')).to.be.rejectedWith(ResourceNotFound);
    });
  });

  describe('own metadata — write', () => {
    it('adds a new entry', async () => {
      const result = await controller.addMetadata(owner, new UserMetadata({ Key: 'user:avatar', Value: 'a.png', Type: 'string' }));

      expect(result).to.be.instanceOf(Ok);
      expect((await metaOf(owner, 'user:avatar'))!.Value).to.eq('a.png');
    });

    it('forces ownership — a user_id sent in the payload is ignored', async () => {
      await controller.addMetadata(owner, new UserMetadata({ Key: 'user:injected', Value: 'x', Type: 'string', user_id: other.Id } as any));

      expect(await metaOf(owner, 'user:injected'), 'entry must land on the caller').to.exist;
      expect(await metaOf(other, 'user:injected'), 'entry must not land on the spoofed user').to.not.exist;
    });

    it('updates an existing entry by key', async () => {
      await controller.updateMetadata(owner, 'user:niceName', { Key: 'user:niceName', Value: 'Renamed', Type: 'string' } as any);

      expect((await metaOf(owner, 'user:niceName'))!.Value).to.eq('Renamed');
    });

    it('updates an existing entry by id', async () => {
      const entry = await metaOf(owner, 'user:phone');

      await controller.updateMetadata(owner, String(entry!.Id), { Key: 'user:phone', Value: '999', Type: 'string' } as any);

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
      const decoy = new UserMetadata();
      decoy.Key = String(phone!.Id);
      decoy.Value = 'decoy';
      decoy.Type = 'string';
      decoy.user_id = owner.Id;
      await decoy.insert();

      await controller.updateMetadata(owner, String(phone!.Id), { Key: 'user:phone', Value: '999', Type: 'string' } as any);

      expect((await metaOf(owner, 'user:phone'))!.Value, 'the addressed entry').to.eq('999');
      expect((await metaOf(owner, String(phone!.Id)))!.Value, 'an entry whose key merely looks like that id must be left alone').to.eq('decoy');
    });

    it('cannot update an entry of another user by key', async () => {
      await expect(controller.updateMetadata(owner, 'secret', { Key: 'secret', Value: 'hacked', Type: 'string' } as any)).to.be.rejectedWith(ResourceNotFound);

      expect((await metaOf(other, 'secret'))!.Value, 'foreign metadata must stay untouched').to.eq('do-not-touch');
    });

    it('cannot update an entry of another user by id', async () => {
      const foreign = await metaOf(other, 'secret');

      await expect(controller.updateMetadata(owner, String(foreign!.Id), { Key: 'secret', Value: 'hacked', Type: 'string' } as any)).to.be.rejectedWith(ResourceNotFound);

      expect((await metaOf(other, 'secret'))!.Value).to.eq('do-not-touch');
    });

    it('deletes an own entry', async () => {
      const entry = await metaOf(owner, 'user:phone');

      const result = await controller.deleteMetadata(owner, entry!.Id);

      expect(result).to.be.instanceOf(Ok);
      expect(await metaOf(owner, 'user:phone')).to.not.exist;
    });

    it('cannot delete an entry of another user', async () => {
      const foreign = await metaOf(other, 'secret');

      await expect(controller.deleteMetadata(owner, foreign!.Id)).to.be.rejectedWith(ResourceNotFound);

      expect(await metaOf(other, 'secret'), 'foreign metadata must survive').to.exist;
    });
  });

  describe('protected metadata keys', () => {
    it('refuses to plant the invite marker through own POST /user/metadata', async () => {
      await expect(
        controller.addMetadata(owner, new UserMetadata({ Key: USER_COMMON_METADATA.USER_INVITE_PENDING, Value: 'true', Type: 'boolean' })),
      ).to.be.rejectedWith(InvalidArgument);

      expect(await metaOf(owner, USER_COMMON_METADATA.USER_INVITE_PENDING)).to.not.exist;
    });

    it('refuses to rewrite an entry Key to the invite marker through own PATCH', async () => {
      await expect(
        controller.updateMetadata(owner, 'user:niceName', { Key: USER_COMMON_METADATA.USER_INVITE_PENDING, Value: 'true', Type: 'boolean' } as any),
      ).to.be.rejectedWith(InvalidArgument);

      expect((await metaOf(owner, 'user:niceName'))!.Value, 'the original entry must be untouched').to.eq('Owner');
      expect(await metaOf(owner, USER_COMMON_METADATA.USER_INVITE_PENDING)).to.not.exist;
    });

    it('refuses to plant the invite marker through the admin route', async () => {
      await expect(
        controller.addUserMetadata(other, new UserMetadata({ Key: USER_COMMON_METADATA.USER_INVITE_PENDING, Value: 'true', Type: 'boolean' })),
      ).to.be.rejectedWith(InvalidArgument);

      expect(await metaOf(other, USER_COMMON_METADATA.USER_INVITE_PENDING)).to.not.exist;
    });

    it('still allows an ordinary key through the generic write API', async () => {
      const result = await controller.addMetadata(owner, new UserMetadata({ Key: 'user:niceName', Value: 'Still Owner', Type: 'string' }));

      expect(result).to.be.instanceOf(Ok);
      expect((await metaOf(owner, 'user:niceName'))!.Value).to.eq('Still Owner');
    });
  });

  describe('admin routes', () => {
    it('lists the metadata of any user', async () => {
      const data = await body<any[]>(await controller.readUserMeta(other, new PaginationDTO({ page: 0, limit: 10 })));

      expect(data.map((m) => m.Key)).to.have.members(['user:niceName', 'secret']);
    });

    it('lists the metadata of any user when no pagination is supplied', async () => {
      const data = await body<any[]>(await controller.readUserMeta(other, new PaginationDTO({})));

      expect(data).to.have.lengthOf(2);
    });

    it('returns a single entry of any user by key', async () => {
      const data = await body<any>(await controller.getUserMeta(other, 'secret'));

      expect(data.Value).to.eq('do-not-touch');
    });

    it('adds metadata to any user', async () => {
      const result = await controller.addUserMetadata(other, new UserMetadata({ Key: 'admin:note', Value: 'checked', Type: 'string' }));

      expect(result).to.be.instanceOf(Ok);
      expect((await metaOf(other, 'admin:note'))!.Value).to.eq('checked');
    });

    it('updates metadata of any user, scoped to that user', async () => {
      const entry = await metaOf(other, 'secret');

      await controller.updateUserMetadata(String(entry!.Id), other, { Key: 'secret', Value: 'reviewed', Type: 'string' } as any);

      expect((await metaOf(other, 'secret'))!.Value).to.eq('reviewed');
      expect((await metaOf(owner, 'user:niceName'))!.Value, 'other accounts must be untouched').to.eq('Owner');
    });

    it('deletes metadata of any user', async () => {
      const entry = await metaOf(other, 'secret');

      const result = await controller.deleteUserMetadata(other, entry!.Id);

      expect(result).to.be.instanceOf(Ok);
      expect(await metaOf(other, 'secret')).to.not.exist;
    });

    it('does not delete an entry that belongs to a different user than the one addressed', async () => {
      const ownerEntry = await metaOf(owner, 'user:phone');

      await expect(controller.deleteUserMetadata(other, ownerEntry!.Id)).to.be.rejectedWith(ResourceNotFound);

      expect(await metaOf(owner, 'user:phone'), 'delete must stay scoped to the addressed user').to.exist;
    });

    it('leaves the rest of the metadata of the user alone when one entry is removed', async () => {
      const entry = await metaOf(other, 'secret');
      await controller.deleteUserMetadata(other, entry!.Id);

      const left = await allMetaOf(other);
      expect(left.map((m) => m.Key)).to.deep.eq(['user:niceName']);
    });

    it('answers 404 for an update of an entry that does not exist', async () => {
      await expect(controller.updateMetadata(owner, 'user:missing', { Key: 'user:missing', Value: 'x', Type: 'string' } as any)).to.be.rejectedWith(ResourceNotFound);
      expect(await metaOf(owner, 'user:missing')).to.not.exist;
    });

    it('answers 404 for a delete of an entry that does not exist', async () => {
      await expect(controller.deleteUserMetadata(other, 999999)).to.be.rejectedWith(ResourceNotFound);
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
      const m = new UserMetadata();
      m.Key = key;
      m.Value = value;
      m.user_id = user.Id;
      await m.insert();
      return (await metaOf(user, key))!;
    };

    const keysOf = async (r: any) => (await body<any[]>(r)).map((m) => m.Key);

    describe('own routes', () => {
      beforeEach(async () => {
        await plant(owner, '2fa:token', 'JBSWY3DPEHPK3PXP');
        await plant(owner, '2fa:enabled', true);
        await plant(owner, 'user:pwd_reset:token', 'reset-token');
        await plant(owner, 'user:invite:pending', true);
      });

      it('lists no reserved key', async () => {
        expect(await keysOf(await controller.readMeta(owner, new PaginationDTO({ page: 0, limit: 50 })))).to.have.members(['user:niceName', 'user:phone']);
      });

      it('fills a page with visible entries only', async () => {
        // reserved rows have the highest ids, so they would lead a DESC page if filtered after the query
        const page = await keysOf(await controller.readMeta(owner, new PaginationDTO({ page: 0, limit: 2 })));

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

        expect(await keysOf(await controller.readMeta(owner, new PaginationDTO({ page: 0, limit: 50 }), undefined, filter as any))).to.deep.eq([]);
      });

      it('lists no reserved key stored in a width variant', async () => {
        await plant(owner, '２fa:otp', '123456');

        expect(await keysOf(await controller.readMeta(owner, new PaginationDTO({ page: 0, limit: 50 })))).to.have.members(['user:niceName', 'user:phone']);
      });

      for (const key of ['2fa:token', '2fa:enabled', 'user:pwd_reset:token', 'user:invite:pending', '2FA:TOKEN', '２fa:token']) {
        it(`answers 404 for a read of ${key}`, async () => {
          await expect(controller.getMeta(owner, key)).to.be.rejectedWith(ResourceNotFound);
        });
      }

      it('answers 404 for a read of a key that does not exist', async () => {
        await expect(controller.getMeta(owner, 'user:missing')).to.be.rejectedWith(ResourceNotFound);
      });

      it('refuses a write of a reserved key and keeps the stored value', async () => {
        await expect(controller.addMetadata(owner, new UserMetadata({ Key: '2fa:enabled', Value: 'false', Type: 'boolean' }))).to.be.rejectedWith(InvalidArgument);

        expect((await metaOf(owner, '2fa:enabled'))!.Value).to.eq(true);
      });

      it('answers 404 for an update addressed by a reserved key', async () => {
        await expect(controller.updateMetadata(owner, '2fa:token', { Key: 'user:avatar', Value: 'x', Type: 'string' } as any)).to.be.rejectedWith(ResourceNotFound);

        expect((await metaOf(owner, '2fa:token'))!.Value).to.eq('JBSWY3DPEHPK3PXP');
      });

      it('answers 404 for an update addressed by the id of a reserved row', async () => {
        const row = await metaOf(owner, 'user:pwd_reset:token');

        await expect(controller.updateMetadata(owner, String(row!.Id), { Key: 'user:avatar', Value: 'x', Type: 'string' } as any)).to.be.rejectedWith(ResourceNotFound);

        const after = await metaOf(owner, 'user:pwd_reset:token');
        expect(after!.Value).to.eq('reset-token');
      });

      it('refuses to rename a plain entry to a reserved key in any case', async () => {
        await expect(controller.updateMetadata(owner, 'user:niceName', { Key: '2FA:Enabled', Value: 'false', Type: 'boolean' } as any)).to.be.rejectedWith(InvalidArgument);

        expect((await metaOf(owner, 'user:niceName'))!.Value).to.eq('Owner');
      });

      it('answers 404 for a delete of a reserved row and keeps it', async () => {
        const row = await metaOf(owner, '2fa:enabled');

        await expect(controller.deleteMetadata(owner, row!.Id)).to.be.rejectedWith(ResourceNotFound);

        expect(await metaOf(owner, '2fa:enabled')).to.exist;
      });

      it('still reads, updates and deletes plain entries', async () => {
        expect((await body<any>(await controller.getMeta(owner, 'user:phone'))).Value).to.eq('111222333');

        await controller.updateMetadata(owner, 'user:phone', { Key: 'user:phone', Value: '444', Type: 'string' } as any);
        expect((await metaOf(owner, 'user:phone'))!.Value).to.eq('444');

        const phone = await metaOf(owner, 'user:phone');
        await controller.deleteMetadata(owner, phone!.Id);
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
        expect(await keysOf(await controller.readUserMeta(other, new PaginationDTO({ page: 0, limit: 50 })))).to.have.members(['user:niceName', 'secret']);
      });

      for (const key of ['user:pwd_reset:token', 'user:2fa:token', 'user:ban:is_banned', 'user:login:attempts', 'User:Pwd_Reset:Token']) {
        it(`answers 404 for a read of ${key}`, async () => {
          await expect(controller.getUserMeta(other, key)).to.be.rejectedWith(ResourceNotFound);
        });
      }

      it('refuses to plant a known 2fa secret', async () => {
        await expect(controller.addUserMetadata(other, new UserMetadata({ Key: '2fa:token', Value: 'KNOWNSECRET', Type: 'string' }))).to.be.rejectedWith(InvalidArgument);

        expect(await metaOf(other, '2fa:token')).to.not.exist;
      });

      it('answers 404 for an update of a reserved row', async () => {
        const row = await metaOf(other, 'user:ban:is_banned');

        await expect(controller.updateUserMetadata(String(row!.Id), other, { Key: 'user:avatar', Value: 'x', Type: 'string' } as any)).to.be.rejectedWith(ResourceNotFound);

        expect((await metaOf(other, 'user:ban:is_banned'))!.Value).to.eq(false);
      });

      it('answers an update of a reserved entry exactly like one of a missing entry', async () => {
        const row = await metaOf(other, 'user:pwd_reset:token');
        const failure = (meta: string, key = 'user:avatar') =>
          controller.updateUserMetadata(meta, other, { Key: key, Value: 'x', Type: 'string' } as any).then(
            () => expect.fail('the update went through'),
            (e: Error) => ({ type: e.constructor, message: e.message }),
          );

        const missing = await failure('999999');
        expect(missing.type).to.eq(ResourceNotFound);
        expect(await failure(String(row!.Id))).to.deep.eq(missing);
        expect(await failure('user:pwd_reset:token')).to.deep.eq(await failure('user:missing'));

        // a reserved body key is refused before any lookup, whether the entry exists or not
        expect(await failure(String(row!.Id), '2fa:token')).to.deep.eq(await failure('999999', '2fa:token'));
      });

      it('answers 404 for a delete of a reserved row and keeps it', async () => {
        const row = await metaOf(other, 'user:2fa:token');

        await expect(controller.deleteUserMetadata(other, row!.Id)).to.be.rejectedWith(ResourceNotFound);

        expect(await metaOf(other, 'user:2fa:token')).to.exist;
      });
    });

    /**
     * MySQL's default collations match spellings the key check cannot foresee to a stored key.
     * SQLite compares bytes, so a stub makes `kit:twin` address the owner's `2fa:enabled` row.
     */
    describe('collation twins', () => {
      beforeEach(async () => {
        await plant(owner, '2fa:enabled', true);

        const where = UserMetadata.where.bind(UserMetadata) as (...args: any[]) => any;
        const twin = Object.assign(new UserMetadata(), { Key: '2fa:enabled', user_id: owner.Id });
        sinon.stub(UserMetadata, 'where').callsFake(((...args: any[]) => (args[0] === 'Key' && args[1] === 'kit:twin' ? { andWhere: async () => [twin] } : where(...args))) as any);
      });

      it('refuses a write whose key addresses a reserved row', async () => {
        await expect(controller.addMetadata(owner, { Key: 'kit:twin', Value: false, Type: 'boolean' } as any)).to.be.rejectedWith(InvalidArgument);
        await expect(controller.addUserMetadata(owner, { Key: 'kit:twin', Value: false, Type: 'boolean' } as any)).to.be.rejectedWith(InvalidArgument);

        expect(await metaOf(owner, 'kit:twin')).to.not.exist;
      });

      it('refuses to rename an entry to a key that addresses a reserved row', async () => {
        await expect(controller.updateMetadata(owner, 'user:niceName', { Key: 'kit:twin', Value: 'x', Type: 'string' } as any)).to.be.rejectedWith(InvalidArgument);

        expect((await metaOf(owner, 'user:niceName'))!.Value).to.eq('Owner');
      });

      it('answers 404 for a read whose key addresses a reserved row', async () => {
        await expect(controller.getMeta(owner, 'kit:twin')).to.be.rejectedWith(ResourceNotFound);
        await expect(controller.updateMetadata(owner, 'kit:twin', { Key: 'user:avatar', Value: 'x', Type: 'string' } as any)).to.be.rejectedWith(ResourceNotFound);
      });
    });
  });
});
