import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { randomUUID } from 'node:crypto';

import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { DefaultQueueService } from '@spinajs/queue';
import { PaginationDTO } from '@spinajs/orm-http';
import { InvalidArgument, ResourceNotFound } from '@spinajs/exceptions';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, User, UserMetadata, issuePasswordResetToken } from '@spinajs/users';
import { Default2FaToken, TWO_FA_METATADATA_KEYS } from '@spinajs/authn-totp';
import { MemorySessionIssuer, runAuthnBehaviour } from '@spinajs/authn-testing';
import type { Harness, MetadataActor, MetadataPort, SeedPort } from '@spinajs/authn-testing';
import { MemoryAuthnThrottle } from '@spinajs/authn';
import { AuthnThrottle, SessionIssuer } from '@spinajs/authn/contracts';

import { UserMetadataController } from '../src/controllers/UserMetadataController.js';
import { UserMetadataService } from '../src/services/UserMetadataService.js';
import { DbTestConfiguration } from './db-common.js';

/**
 * Regression tests for SR-01 and SR-02 (design §23.3, plan §3c SEC1).
 *
 * Every case replays the 2.x attack through the metadata route handlers, called with the
 * arguments the http layer resolves, and must fail closed. The A12/api facet of the authn kit
 * runs over the same handlers through a {@link MetadataPort} adapter.
 */

type IdentityRef = Parameters<MetadataPort['seedRaw']>[0];

const body = async <T = any>(r: any): Promise<T> => await r.responseData;

/** Refusals the routes answer (400, 404); anything else is a bug the case must see. */
const refused = (e: unknown) => e instanceof InvalidArgument || e instanceof ResourceNotFound;

async function attempt(op: () => Promise<unknown>): Promise<{ ok: boolean }> {
  try {
    await op();
    return { ok: true };
  } catch (e) {
    if (refused(e)) {
      return { ok: false };
    }
    throw e;
  }
}

const typeOf = (value: unknown) => (typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'string');

describe('SR-01 and SR-02: users-http metadata routes', function () {
  this.timeout(25000);

  let controller: UserMetadataController;
  let pwd: BasicPasswordProvider;

  // Only what this suite resolves is uncached; the in-memory database goes with the Orm.
  const owned = [DbTestConfiguration, Configuration, Orm, UserMetadataController, UserMetadataService, BasicPasswordProvider, Default2FaToken];

  before(async () => {
    DI.setESMModuleSupport();
    owned.forEach((t) => DI.uncache(t as any));

    DI.register(DbTestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    DI.register(SimpleDbAuthProvider).as(AuthProvider);
    // The reset request runs authn-local's LocalPasswordService, which counts it in the throttle and needs a
    // session issuer; nothing in this package's imports registers either.
    DI.register(MemoryAuthnThrottle).as(AuthnThrottle);
    DI.register(MemorySessionIssuer).as(SessionIssuer);

    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration);
    await DI.resolve(Orm);

    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    controller = await DI.resolve(UserMetadataController);
    pwd = DI.resolve(BasicPasswordProvider);
  });

  after(() => {
    sinon.restore();
    DI.unregister(DbTestConfiguration);
    owned.forEach((t) => DI.uncache(t as any));
  });

  async function newUser(login = `u-${randomUUID()}`): Promise<User> {
    const u = new User({
      Uuid: randomUUID(),
      Email: `${login}@spinajs.pl`,
      Login: login,
      Password: await pwd.hash('kit-password-1'),
      Role: ['user'],
      IsActive: true,
    });
    await u.insert();
    return u;
  }

  const byUuid = async (uuid: string) => (await User.where('Uuid', uuid).firstOrFail()) as User;
  const rowOf = (user: User, key: string) => UserMetadata.where({ user_id: user.Id, Key: key }).first();
  const rowsOf = (user: User) => UserMetadata.where('user_id', user.Id) as unknown as Promise<UserMetadata[]>;
  const listed = async (r: any) => (await body<any[]>(r)).map((m) => m.Key as string);
  const all = () => new PaginationDTO({ page: 0, limit: 1000 });

  /** The guard-free writer: a plain insert, as authn and the user actions write their state. */
  async function plant(user: User, key: string, value: unknown): Promise<UserMetadata> {
    const m = new UserMetadata();
    m.Key = key;
    m.Value = value;
    m.user_id = user.Id;
    await m.insert();
    return (await rowOf(user, key))!;
  }

  describe('replays of the 2.x attacks', () => {
    it("SR-01 admin reads another user's reset token", async () => {
      const victim = await newUser();
      // The public POST /auth/password/reset-request runs this action. authn-local keeps the secret in its own
      // store, so a reset token row is one a 2.x writer left behind.
      await issuePasswordResetToken(victim.Uuid);
      expect(await rowOf(victim, 'user:pwd_reset:token'), 'the reset request writes no secret to the metadata').to.not.exist;
      const token = 'a-2x-reset-token-worth-stealing';
      await plant(victim, 'user:pwd_reset:token', token);

      await expect(controller.getUserMeta(victim, 'user:pwd_reset:token')).to.be.rejectedWith(ResourceNotFound);

      const keys = await listed(await controller.readUserMeta(victim, all()));
      expect(keys.filter((k) => k.startsWith('user:pwd_reset:'))).to.deep.eq([]);
      expect(JSON.stringify(await body(await controller.readUserMeta(victim, all())))).to.not.contain(token);
    });

    it('SR-01 owner reads own 2fa secret', async () => {
      const owner = await newUser();
      const totp = DI.resolve(Default2FaToken);
      await totp.beginEnrolment(await byUuid(owner.Uuid));
      const secret = (await rowOf(owner, TWO_FA_METATADATA_KEYS.TOKEN))!.Value as string;
      expect(secret, 'precondition: the secret is stored').to.be.a('string').and.not.empty;

      for (const key of [TWO_FA_METATADATA_KEYS.TOKEN, TWO_FA_METATADATA_KEYS.OTP]) {
        await expect(controller.getMeta(owner, key), key).to.be.rejectedWith(ResourceNotFound);
      }

      const page = await body<any[]>(await controller.readMeta(owner, all()));
      expect(page.map((m) => m.Key).filter((k: string) => k.startsWith('2fa:'))).to.deep.eq([]);
      expect(JSON.stringify(page)).to.not.contain(secret);
    });

    it('SR-02 2fa:enabled write by owner', async () => {
      const owner = await newUser();
      await plant(owner, TWO_FA_METATADATA_KEYS.ENABLED, true);

      // 2.x: POST /user/metadata {Key:'2fa:enabled', Value:false} turned 2FA off without the password
      await expect(controller.addMetadata(owner, { Key: '2fa:enabled', Value: false, Type: 'boolean' } as any)).to.be.rejectedWith(InvalidArgument);
      await expect(controller.addMetadata(owner, { Key: '2FA:Enabled', Value: false, Type: 'boolean' } as any)).to.be.rejectedWith(InvalidArgument);

      const row = await rowOf(owner, TWO_FA_METATADATA_KEYS.ENABLED);
      expect(row!.Value).to.eq(true);
      expect((await rowsOf(owner)).map((m) => m.Key)).to.deep.eq([TWO_FA_METATADATA_KEYS.ENABLED]);
    });

    it('SR-02 admin plants a known 2fa secret', async () => {
      const target = await newUser();

      await expect(controller.addUserMetadata(target, { Key: '2fa:token', Value: 'KNOWNSECRETBASE32', Type: 'string' } as any)).to.be.rejectedWith(InvalidArgument);

      expect(await rowOf(target, '2fa:token')).to.not.exist;
    });

    it('SR-02 delete protected row by id', async () => {
      const target = await newUser();
      const secret = await plant(target, '2fa:token', 'JBSWY3DPEHPK3PXP');
      const ban = await plant(target, 'user:ban:is_banned', true);

      // 2.x: DELETE …/metadata/:id deleted any key, protected or not
      await expect(controller.deleteUserMetadata(target, secret.Id)).to.be.rejectedWith(ResourceNotFound);
      await expect(controller.deleteMetadata(target, ban.Id)).to.be.rejectedWith(ResourceNotFound);

      expect(await rowOf(target, '2fa:token')).to.exist;
      expect(await rowOf(target, 'user:ban:is_banned')).to.exist;
    });

    it('SR-02 rename of a protected row by id', async () => {
      const target = await newUser();
      const ban = await plant(target, 'user:ban:is_banned', true);

      // renaming the row away from its reserved key lifts the ban just like deleting it
      await expect(controller.updateMetadata(target, String(ban.Id), { Key: 'user:note', Value: 'x', Type: 'string' } as any)).to.be.rejectedWith(ResourceNotFound);
      await expect(controller.updateUserMetadata(String(ban.Id), target, { Key: 'user:note', Value: 'x', Type: 'string' } as any)).to.be.rejectedWith(ResourceNotFound);

      expect((await rowOf(target, 'user:ban:is_banned'))!.Value).to.eq(true);
      expect(await rowOf(target, 'user:note')).to.not.exist;
    });
  });

  /** The kit's A12/api cases over the same handlers. */
  function harness(): Harness {
    const created: User[] = [];

    const seed: SeedPort = {
      async user(spec) {
        const u = await newUser(spec.login);
        created.push(u);
        return { type: 'user', id: u.Uuid };
      },
      async setStatus() {
        throw new Error('A12/api sets no identity status');
      },
    };

    const userOf = (id: IdentityRef) => byUuid(id.id);

    const metadata: MetadataPort = {
      async seedRaw(id, key, value) {
        return String((await plant(await userOf(id), key, value)).Id);
      },
      async rawKeys(id) {
        return (await rowsOf(await userOf(id))).map((m) => m.Key);
      },
      async rawValue(id, key) {
        return (await rowOf(await userOf(id), key))?.Value;
      },
      async write(as: MetadataActor, id, key, value) {
        const u = await userOf(id);
        const dto = { Key: key, Value: value, Type: typeOf(value) } as any;
        return attempt(() => (as === 'owner' ? controller.addMetadata(u, dto) : controller.addUserMetadata(u, dto)));
      },
      async read(as, id, key) {
        const u = await userOf(id);
        try {
          const entry = await body<any>(as === 'owner' ? await controller.getMeta(u, key) : await controller.getUserMeta(u, key));
          return { found: true, value: entry.Value };
        } catch (e) {
          if (e instanceof ResourceNotFound) {
            return { found: false };
          }
          throw e;
        }
      },
      async list(as, id) {
        const u = await userOf(id);
        return listed(as === 'owner' ? await controller.readMeta(u, all()) : await controller.readUserMeta(u, all()));
      },
      async updateById(as, id, rowId, value) {
        const u = await userOf(id);
        // A plain body key, so the refusal has to come from the addressed row, not the body.
        const dto = { Key: 'kit:renamed', Value: value, Type: typeOf(value) } as any;
        return attempt(() => (as === 'owner' ? controller.updateMetadata(u, rowId, dto) : controller.updateUserMetadata(rowId, u, dto)));
      },
      async deleteById(as, id, rowId) {
        const u = await userOf(id);
        return attempt(() => (as === 'owner' ? controller.deleteMetadata(u, Number(rowId)) : controller.deleteUserMetadata(u, Number(rowId))));
      },
    };

    return {
      seed,
      metadata,
      // users only soft-delete, so the fixed login is freed by renaming instead
      async dispose() {
        for (const u of created) {
          const gone = `gone-${randomUUID()}`;
          await User.update({ Login: gone, Email: `${gone}@spinajs.pl` } as any).where('Id', u.Id);
        }
      },
    };
  }

  runAuthnBehaviour(['A12'], () => harness(), { title: 'A12/api over the users-http metadata routes', facets: ['A12/api'], claim: ['A12/api'], fakeDate: false });
});
