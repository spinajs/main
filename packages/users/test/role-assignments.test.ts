import { BasicPasswordProvider } from '../src/password.js';
import { Bootstrapper, DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument } from '@spinajs/exceptions';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { DefaultQueueService } from '@spinajs/queue';
import { GLOBAL, SYSTEM } from '@spinajs/authz';
import { join, normalize, resolve } from 'path';

import { AuthProvider, PasswordProvider, SimpleDbAuthProvider, User } from '../src/index.js';
import { create, getUsersByRole, grant, revoke } from '../src/actions.js';
import { TestConfiguration } from './common.test.js';
import { TEST_USER_UUID } from './migration/rbac.migration.js';
import { globalRolesOf, registerAuthzHost, rootAdmin } from './support/authz-host.js';

chai.use(chaiAsPromised);

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

async function refusal(p: Promise<unknown>): Promise<InvalidArgument> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).to.be.instanceOf(InvalidArgument);
  return err as InvalidArgument;
}

describe('roles as GLOBAL assignments (H13)', function () {
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

  describe('users table', () => {
    it('has no Role column after the authz-rbac migrations', async () => {
      const columns = await User.query().Driver.tableInfo('users');

      expect(columns?.map((c) => c.Name)).to.not.include('Role');
    });

    it('stores a user built without roles, and reads it back without one', async () => {
      const u = new User({ Email: 'plain@spinajs.pl', Login: 'plain', Password: 'x', IsActive: true });
      await u.insert();

      const read = await User.query().whereLogin('plain').firstOrFail();
      expect(read.Role).to.eq(undefined);
    });
  });

  describe('IsGuest', () => {
    it('is true only for a user that was never stored', async () => {
      expect(new User({ Login: 'guest' }).IsGuest).to.eq(true);
      expect((await User.query().whereLogin('test').firstOrFail()).IsGuest).to.eq(false);
    });
  });

  describe('create', () => {
    it('grants its roles as GLOBAL assignments of user:<Uuid>', async () => {
      const { User: u } = await create('assigned@spinajs.pl', 'assigned', ['user', ' editor ', 'user'], { password: 'passw0rd123' });

      expect(await globalRolesOf(u.Uuid)).to.have.members(['user', 'editor']);
    });

    it('refuses an unknown role through AuthzAdmin and writes nothing', async () => {
      const err = await refusal(create('ghost@spinajs.pl', 'ghost', ['user', 'not-a-role'], { password: 'passw0rd123' }));

      expect(err.fieldName).to.eq('roles');
      expect(err.errorCode).to.eq('unknown_role');
      expect(await User.query().whereLogin('ghost').first()).to.not.exist;
    });

    it('refuses a role that is not assignable', async () => {
      const err = await refusal(create('unassignable@spinajs.pl', 'unassignable', ['admin.users'], { password: 'passw0rd123' }));

      expect(err.errorCode).to.eq('not_assignable');
      expect(await User.query().whereLogin('unassignable').first()).to.not.exist;
    });
  });

  describe('grant and revoke (deprecated)', () => {
    it('grant writes a GLOBAL assignment through AuthzAdmin, once', async () => {
      await grant('test@spinajs.pl', 'editor');
      await grant('test@spinajs.pl', 'editor');

      expect((await globalRolesOf(TEST_USER_UUID)).filter((r) => r === 'editor')).to.have.lengthOf(1);
    });

    it('grant and revoke publish no users queue event: RoleAssigned and RoleRevoked come from AuthzAdmin (B27)', async () => {
      const emit = DefaultQueueService.prototype.emit as sinon.SinonStub;

      await grant('test@spinajs.pl', 'editor');
      await revoke('test@spinajs.pl', 'editor');

      expect(emit.callCount).to.eq(0);
    });

    it('grant refuses an unknown role', async () => {
      const err = await refusal(grant('test@spinajs.pl', 'not-a-role'));

      expect(err.errorCode).to.eq('unknown_role');
    });

    it('revoke removes the GLOBAL assignment and leaves the others', async () => {
      await grant('test@spinajs.pl', 'editor');
      await revoke('test@spinajs.pl', 'editor');

      const roles = await globalRolesOf(TEST_USER_UUID);
      expect(roles).to.not.include('editor');
      expect(roles).to.include('admin');
    });
  });

  describe('role holders', () => {
    it('getUsersByRole answers from assignments', async () => {
      const u = new User({ Email: 'holder@spinajs.pl', Login: 'holder', Password: 'x', IsActive: true });
      await u.insert();
      await (await rootAdmin()).assign(SYSTEM, { subject: { type: 'user', id: u.Uuid }, role: 'normal', scope: GLOBAL });

      expect((await getUsersByRole(['normal'])).map((x) => x.Login)).to.deep.eq(['holder']);
      expect((await getUsersByRole(['admin'])).map((x) => x.Login)).to.include('test');
    });

    it('getUsersByRole ignores an assignment at another scope', async () => {
      const u = new User({ Email: 'scoped@spinajs.pl', Login: 'scoped', Password: 'x', IsActive: true });
      await u.insert();
      await (await rootAdmin()).assign(SYSTEM, { subject: { type: 'user', id: u.Uuid }, role: 'normal', scope: { type: 'project', id: 'p1' } });

      expect(await getUsersByRole(['normal'])).to.deep.eq([]);
    });

    it('the deprecated withRole scope answers from assignments', async () => {
      await grant('test@spinajs.pl', 'editor');

      const users = await User.query().withRole(['editor']);
      expect(users.map((x) => x.Login)).to.deep.eq(['test']);

      await revoke('test@spinajs.pl', 'editor');
      expect(await User.query().withRole(['editor'])).to.deep.eq([]);
    });
  });
});
