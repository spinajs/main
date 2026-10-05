import { Bootstrapper, DI } from '@spinajs/di';
import * as chai from 'chai';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { DefaultQueueService } from '@spinajs/queue';
import { GLOBAL, SYSTEM } from '@spinajs/authz';
import type { AuthzCommandResult, Principal } from '@spinajs/authz';
import { AccountStatusSource, AssignmentStore } from '@spinajs/authz-rbac';
import { DateTime } from 'luxon';
import { v4 as uuidv4 } from 'uuid';
import chaiAsPromised from 'chai-as-promised';

import { AuthProvider, PasswordProvider, SimpleDbAuthProvider, USER_COMMON_METADATA, User } from '../src/index.js';
import { create } from '../src/actions.js';
import { BasicPasswordProvider } from '../src/password.js';
import { TestConfiguration, dir } from './common.test.js';
import { TEST_USER_UUID, TEST_USER_UUID_3 } from './migration/rbac.migration.js';
import { registerAuthzHost, rootAdmin } from './support/authz-host.js';

chai.use(chaiAsPromised);

const key = (uuid: string) => `user:${uuid}`;
const ref = (uuid: string) => ({ type: 'user', id: uuid });

async function source(): Promise<AccountStatusSource> {
  return (await DI.resolve(AccountStatusSource)) as AccountStatusSource;
}

async function insertUser(login: string, extra: Partial<User> = {}): Promise<User> {
  const u = new User({ Email: `${login}@spinajs.pl`, Login: login, Password: 'x', IsActive: true, Uuid: uuidv4(), ...extra });
  await u.insert();
  return u;
}

async function uuidOf(login: string): Promise<string> {
  return (await User.query().withDeleted().whereLogin(login).firstOrFail()).Uuid;
}

function userPrincipal(uuid: string): Principal {
  return { type: 'user', id: uuid, authenticated: true, source: 'session', attributes: {} };
}

const code = (results: readonly AuthzCommandResult[]) => (results[0].ok ? 'ok' : results[0].error.code);

describe('UserAccountStatusSource: accounts in service for the admin guard', function () {
  this.timeout(30000);

  before(() => {
    DI.register(SimpleDbAuthProvider).as(AuthProvider);
    DI.register(TestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    registerAuthzHost();
  });

  beforeEach(async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration, [null, null, [dir('./config')]]);
    await DI.resolve(Orm);
  });

  afterEach(() => {
    sinon.restore();
    DI.clearCache();
  });

  describe('inService', () => {
    it('an active, unbanned, undeleted user with a password is in service', async () => {
      expect((await (await source()).inService([ref(TEST_USER_UUID)])).get(key(TEST_USER_UUID))).to.eq(true);
    });

    it('a banned user is not', async () => {
      expect((await (await source()).inService([ref(TEST_USER_UUID_3)])).get(key(TEST_USER_UUID_3))).to.eq(false);
    });

    it('a ban that has run out does not count', async () => {
      const u = await insertUser('ban-over');
      u.Metadata[USER_COMMON_METADATA.USER_BAN_IS_BANNED] = true;
      u.Metadata[USER_COMMON_METADATA.USER_BAN_START_DATE] = DateTime.now().minus({ days: 2 });
      u.Metadata[USER_COMMON_METADATA.USER_BAN_DURATION] = 60;
      await u.Metadata.sync();

      expect((await (await source()).inService([ref(u.Uuid)])).get(key(u.Uuid))).to.eq(true);
    });

    it('a deactivated user is not', async () => {
      const uuid = await uuidOf('test-notactive');
      expect((await (await source()).inService([ref(uuid)])).get(key(uuid))).to.eq(false);
    });

    it('a soft-deleted user is not, though it was active', async () => {
      const u = await insertUser('gone');
      await u.destroy();

      expect((await (await source()).inService([ref(u.Uuid)])).get(key(u.Uuid))).to.eq(false);
    });

    it('an unknown Uuid is not', async () => {
      const uuid = uuidv4();
      expect((await (await source()).inService([ref(uuid)])).get(key(uuid))).to.eq(false);
    });

    it("a user whose password holds authn-local's expiry marker is not", async () => {
      const u = await insertUser('expired', { Password: '!expired' });
      expect((await (await source()).inService([ref(u.Uuid)])).get(key(u.Uuid))).to.eq(false);
    });

    it('an active user without a password (invite redeemed elsewhere, OIDC) is in service', async () => {
      const u = await insertUser('no-password', { Password: '!none' });
      expect((await (await source()).inService([ref(u.Uuid)])).get(key(u.Uuid))).to.eq(true);
    });

    it('a principal of another type is not, even with the Uuid of an active user', async () => {
      const answers = await (await source()).inService([{ type: 'service', id: TEST_USER_UUID }]);
      expect(answers.get(`service:${TEST_USER_UUID}`)).to.eq(false);
    });

    it('answers a batch in one call, every ref keyed by principalKey', async () => {
      const extra = await Promise.all(Array.from({ length: 120 }, (_, i) => insertUser(`batch-${i}`)));
      const deactivated = await uuidOf('test-notactive');
      const unknown = uuidv4();
      const refs = [ref(TEST_USER_UUID), ref(TEST_USER_UUID_3), ref(deactivated), ref(unknown), { type: 'agent', id: 'a1' }, ...extra.map((u) => ref(u.Uuid)), ref(TEST_USER_UUID)];

      const answers = await (await source()).inService(refs);

      expect(answers.size).to.eq(125);
      expect([key(TEST_USER_UUID), key(TEST_USER_UUID_3), key(deactivated), key(unknown), 'agent:a1'].map((k) => answers.get(k))).to.deep.eq([true, false, false, false, false]);
      expect(extra.every((u) => answers.get(key(u.Uuid)) === true)).to.eq(true);
    });
  });

  describe('AuthzAdmin last_holder (in process: users has no /authz/* HTTP harness)', () => {
    async function adminRowOf(uuid: string): Promise<string> {
      const store = (await DI.resolve(AssignmentStore)) as AssignmentStore;
      const rows = await store.forSubjects([{ type: 'user', id: uuid }], new Date());
      return rows.find((a) => a.role === 'admin' && a.scope.type === GLOBAL.type)!.id;
    }

    async function assigner(): Promise<Principal> {
      const { User: u } = await create('assigner@spinajs.pl', 'assigner', ['assigner'], { password: 'passw0rd123' });
      return userPrincipal(u.Uuid);
    }

    it('the last active admin cannot be revoked while a banned (and a deactivated, a deleted) admin exists', async () => {
      const actor = await assigner();
      const admin = await rootAdmin();

      expect(code(await admin.execute(actor, [{ kind: 'assignment.revoke', id: await adminRowOf(TEST_USER_UUID) }]))).to.eq('last_holder');
      expect(await adminRowOf(TEST_USER_UUID)).to.be.a('string');
    });

    it('with a second active admin the revoke passes', async () => {
      const actor = await assigner();
      const admin = await rootAdmin();
      const second = await insertUser('second-admin');
      await admin.assign(SYSTEM, { subject: { type: 'user', id: second.Uuid }, role: 'admin', scope: GLOBAL });

      expect(code(await admin.execute(actor, [{ kind: 'assignment.revoke', id: await adminRowOf(TEST_USER_UUID) }]))).to.eq('ok');
    });

    it('an admin whose password an admin expired does not count either', async () => {
      const actor = await assigner();
      const admin = await rootAdmin();
      const second = await insertUser('expired-admin', { Password: '!expired' });
      await admin.assign(SYSTEM, { subject: { type: 'user', id: second.Uuid }, role: 'admin', scope: GLOBAL });

      expect(code(await admin.execute(actor, [{ kind: 'assignment.revoke', id: await adminRowOf(TEST_USER_UUID) }]))).to.eq('last_holder');
    });
  });
});
