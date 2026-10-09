import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { randomUUID } from 'node:crypto';

import { DI } from '@spinajs/di';
import { DefaultQueueService } from '@spinajs/queue';
import { PasswordService } from '@spinajs/authn/contracts';
import { User, UserMetadataBase } from '@spinajs/users';
import { runAuthnBehaviour } from '@spinajs/authn-testing';
import type { Harness, MetadataActor, MetadataPort, SeedPort } from '@spinajs/authn-testing';

import { UserMetadataController } from '../src/controllers/UserMetadataController.js';
import { startUsersHttpApp, stopUsersHttpApp } from './support/http-app.js';
import type { HttpClient, Res, UsersHttpApp } from './support/http-app.js';

/**
 * Regression tests for SR-01 and SR-02 (design §23.3, plan §3c SEC1).
 *
 * Every case replays the 2.x attack through the metadata routes of a running app, as the owner (users' `user` role, on
 * `/user/metadata`) or as an admin (users' `admin` role, on `/user/:uuid/metadata`), and must fail closed. The A12/api
 * facet of the authn kit runs over the same routes through a {@link MetadataPort} adapter.
 */

/** The keys the 2.x authn-totp wrote; users has no constant for them. */
const TWO_FA_KEYS = { TOKEN: '2fa:token', OTP: '2fa:otp', ENABLED: '2fa:enabled' } as const;

type IdentityRef = Parameters<MetadataPort['seedRaw']>[0];

/** Refusals the routes answer (400, 404); anything else is a bug the case must see. */
const refused = (res: Res) => res.status === 400 || res.status === 404;

function attempt(res: Res): { ok: boolean } {
  if (res.status === 200) {
    return { ok: true };
  }
  if (refused(res)) {
    return { ok: false };
  }
  throw new Error(`unexpected ${res.status}: ${res.text}`);
}

const typeOf = (value: unknown) => (typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'string');

/** The request body of a write: the DTO carries every value as a string, its Type says what it is. */
const dto = (Key: string, value: unknown) => ({ Key, Value: String(value), Type: typeOf(value) });

describe('SR-01 and SR-02: users-http metadata routes', function () {
  this.timeout(60000);

  let app: UsersHttpApp;
  let adminClient: HttpClient;

  before(async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));
    app = await startUsersHttpApp({ controllers: [UserMetadataController] });
    adminClient = await app.signIn((await app.seedUser({ login: `sr-admin-${randomUUID()}`, roles: ['admin'] })).Uuid);
  });

  after(async () => {
    await stopUsersHttpApp();
    sinon.restore();
  });

  const newUser = (login = `u-${randomUUID()}`) => app.seedUser({ login, email: `${login}@spinajs.pl`, roles: ['user'] });

  const byUuid = async (uuid: string) => (await User.where('Uuid', uuid).firstOrFail()) as User;
  const rowOf = (user: User, key: string) => UserMetadataBase.where({ user_id: user.Id, Key: key }).first() as Promise<UserMetadataBase | undefined>;
  const rowsOf = (user: User) => UserMetadataBase.where('user_id', user.Id) as unknown as Promise<UserMetadataBase[]>;
  const listed = (res: Res) => (res.body as { Key: string }[]).map((m) => m.Key);
  const ALL = `?pagination=${encodeURIComponent(JSON.stringify({ page: 0, limit: 1000 }))}`;

  /** The guard-free writer: a plain insert, as authn and the user actions write their state. */
  async function plant(user: User, key: string, value: unknown): Promise<UserMetadataBase> {
    const m = new UserMetadataBase();
    m.Key = key;
    m.Value = value;
    m.user_id = user.Id;
    await m.insert();
    return (await rowOf(user, key))!;
  }

  /** A signed-in owner whose reserved ban row says not banned: the account keeps its session, so the guard is what refuses. */
  async function unbannedOwner(): Promise<{ user: User; row: UserMetadataBase; client: HttpClient }> {
    const user = await newUser();
    const row = await plant(user, 'user:ban:is_banned', false);
    return { user, row, client: await app.signIn(user.Uuid) };
  }

  /** The client of an actor on `user`: the user itself on its own family, or the admin on the uuid family. */
  async function as(actor: MetadataActor, user: User): Promise<{ client: HttpClient; base: string }> {
    return actor === 'owner' ? { client: await app.signIn(user.Uuid), base: '/user/metadata' } : { client: adminClient, base: `/user/${user.Uuid}/metadata` };
  }

  describe('replays of the 2.x attacks', () => {
    it("SR-01 admin reads another user's reset token", async () => {
      const victim = await newUser();
      // The public POST /auth/password/reset-request runs this action. authn-local keeps the secret in its own
      // store, so a reset token row is one a 2.x writer left behind.
      await ((await DI.resolve(PasswordService)) as PasswordService).requestReset(victim.Email, { now: new Date(), purpose: 'request' });
      expect(await rowOf(victim, 'user:pwd_reset:token'), 'the reset request writes no secret to the metadata').to.not.exist;
      const token = 'a-2x-reset-token-worth-stealing';
      await plant(victim, 'user:pwd_reset:token', token);

      expect((await adminClient.get(`/user/${victim.Uuid}/metadata/user:pwd_reset:token`)).status).to.eq(404);

      const list = await adminClient.get(`/user/${victim.Uuid}/metadata${ALL}`);
      expect(list.status, list.text).to.eq(200);
      expect(listed(list).filter((k) => k.startsWith('user:pwd_reset:'))).to.deep.eq([]);
      expect(list.text).to.not.contain(token);
    });

    it('SR-01 owner reads own 2fa secret', async () => {
      const owner = await newUser();
      const secret = 'JBSWY3DPEHPK3PXP';
      await plant(owner, TWO_FA_KEYS.TOKEN, secret);
      await plant(owner, TWO_FA_KEYS.OTP, `otpauth://totp/SpinaJS:${owner.Email}?secret=${secret}&issuer=SpinaJS`);
      const client = await app.signIn(owner.Uuid);

      for (const key of [TWO_FA_KEYS.TOKEN, TWO_FA_KEYS.OTP]) {
        expect((await client.get(`/user/metadata/${key}`)).status, key).to.eq(404);
      }

      const page = await client.get(`/user/metadata${ALL}`);
      expect(page.status, page.text).to.eq(200);
      expect(listed(page).filter((k: string) => k.startsWith('2fa:'))).to.deep.eq([]);
      expect(page.text).to.not.contain(secret);
    });

    it('SR-02 2fa:enabled write by owner', async () => {
      const owner = await newUser();
      await plant(owner, TWO_FA_KEYS.ENABLED, true);
      const client = await app.signIn(owner.Uuid);

      // 2.x: POST /user/metadata {Key:'2fa:enabled', Value:false} turned 2FA off without the password
      expect((await client.post('/user/metadata', dto('2fa:enabled', false))).status).to.eq(400);
      expect((await client.post('/user/metadata', dto('2FA:Enabled', false))).status).to.eq(400);

      const row = await rowOf(owner, TWO_FA_KEYS.ENABLED);
      expect(row!.Value).to.eq(true);
      expect((await rowsOf(owner)).map((m) => m.Key)).to.deep.eq([TWO_FA_KEYS.ENABLED]);
    });

    it('SR-02 admin plants a known 2fa secret', async () => {
      const target = await newUser();

      expect((await adminClient.post(`/user/${target.Uuid}/metadata`, dto('2fa:token', 'KNOWNSECRETBASE32'))).status).to.eq(400);

      expect(await rowOf(target, '2fa:token')).to.not.exist;
    });

    it('SR-02 delete protected row by id', async () => {
      const target = await newUser();
      const secret = await plant(target, '2fa:token', 'JBSWY3DPEHPK3PXP');
      const ban = await plant(target, 'user:ban:is_banned', true);

      // 2.x: DELETE …/metadata/:id deleted any key, protected or not
      expect((await adminClient.del(`/user/${target.Uuid}/metadata/${secret.Id}`)).status).to.eq(404);
      // 2.x served the banned owner; 3.0 refuses its session before the route runs.
      expect((await (await app.signIn(target.Uuid)).del(`/user/metadata/${ban.Id}`)).status).to.eq(401);
      // An owner who is not banned reaches the route, and the guard refuses the row.
      const lifted = await unbannedOwner();
      expect((await lifted.client.del(`/user/metadata/${lifted.row.Id}`)).status).to.eq(404);

      expect(await rowOf(target, '2fa:token')).to.exist;
      expect(await rowOf(target, 'user:ban:is_banned')).to.exist;
      expect(await rowOf(lifted.user, 'user:ban:is_banned')).to.exist;
    });

    it('SR-02 rename of a protected row by id', async () => {
      const target = await newUser();
      const ban = await plant(target, 'user:ban:is_banned', true);

      // renaming the row away from its reserved key lifts the ban just like deleting it
      expect((await (await app.signIn(target.Uuid)).patch(`/user/metadata/${ban.Id}`, dto('user:note', 'x'))).status).to.eq(401);
      expect((await adminClient.patch(`/user/${target.Uuid}/metadata/${ban.Id}`, dto('user:note', 'x'))).status).to.eq(404);
      const lifted = await unbannedOwner();
      expect((await lifted.client.patch(`/user/metadata/${lifted.row.Id}`, dto('user:note', 'x'))).status).to.eq(404);

      expect((await rowOf(target, 'user:ban:is_banned'))!.Value).to.eq(true);
      expect(await rowOf(target, 'user:note')).to.not.exist;
      expect(await rowOf(lifted.user, 'user:note')).to.not.exist;
    });
  });

  /** The kit's A12/api cases over the same routes. */
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
      async write(actor, id, key, value) {
        const { client, base } = await as(actor, await userOf(id));
        return attempt(await client.post(base, dto(key, value)));
      },
      async read(actor, id, key) {
        const { client, base } = await as(actor, await userOf(id));
        const res = await client.get(`${base}/${encodeURIComponent(key)}`);
        if (res.status === 404) {
          return { found: false };
        }
        attempt(res);
        return { found: true, value: res.body.Value };
      },
      async list(actor, id) {
        const { client, base } = await as(actor, await userOf(id));
        const res = await client.get(`${base}${ALL}`);
        attempt(res);
        return listed(res);
      },
      async updateById(actor, id, rowId, value) {
        const { client, base } = await as(actor, await userOf(id));
        // A plain body key, so the refusal has to come from the addressed row, not the body.
        return attempt(await client.patch(`${base}/${rowId}`, dto('kit:renamed', value)));
      },
      async deleteById(actor, id, rowId) {
        const { client, base } = await as(actor, await userOf(id));
        return attempt(await client.del(`${base}/${rowId}`));
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
