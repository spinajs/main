import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm, SortOrder } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { DefaultQueueService } from '@spinajs/queue';
import { Ok } from '@spinajs/http';
import { OrderDTO, PaginationDTO } from '@spinajs/orm-http';

import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, User, UserMetadata } from '@spinajs/rbac';

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
      await expect(body(await controller.getMeta(owner, 'secret'))).to.be.rejected;
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
      await controller.updateMetadata(owner, 'secret', { Key: 'secret', Value: 'hacked', Type: 'string' } as any);

      expect((await metaOf(other, 'secret'))!.Value, 'foreign metadata must stay untouched').to.eq('do-not-touch');
    });

    it('cannot update an entry of another user by id', async () => {
      const foreign = await metaOf(other, 'secret');

      await controller.updateMetadata(owner, String(foreign!.Id), { Key: 'secret', Value: 'hacked', Type: 'string' } as any);

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

      await controller.deleteMetadata(owner, foreign!.Id);

      expect(await metaOf(other, 'secret'), 'foreign metadata must survive').to.exist;
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

      await controller.updateUserMetadata(entry!, other, { Key: 'secret', Value: 'reviewed', Type: 'string' } as any);

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

      await controller.deleteUserMetadata(other, ownerEntry!.Id);

      expect(await metaOf(owner, 'user:phone'), 'delete must stay scoped to the addressed user').to.exist;
    });

    it('leaves the rest of the metadata of the user alone when one entry is removed', async () => {
      const entry = await metaOf(other, 'secret');
      await controller.deleteUserMetadata(other, entry!.Id);

      const left = await allMetaOf(other);
      expect(left.map((m) => m.Key)).to.deep.eq(['user:niceName']);
    });
  });
});
