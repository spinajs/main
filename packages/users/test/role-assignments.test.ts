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
import { AuthzAdminFailure, DefaultAuthzAdmin, GLOBAL, SYSTEM } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { AUTHZ_ASSIGNMENT_TABLE, AssignmentStore } from '@spinajs/authz-rbac';
import { v4 as uuidv4 } from 'uuid';
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

async function adminFailure(p: Promise<unknown>): Promise<AuthzAdminFailure> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).to.be.instanceOf(AuthzAdminFailure);
  return err as AuthzAdminFailure;
}

function userPrincipal(uuid: string): Principal {
  return { type: 'user', id: uuid, authenticated: true, source: 'session', attributes: {} };
}

/** An authz_assignment row AuthzAdmin would refuse to write (past expiry) or one naming a subject set. */
async function insertAssignmentRow(row: { subject_type: string; subject_id: string; subject_role?: string; role: string; scope_type: string; scope_id?: string; expires_at?: Date | null }): Promise<void> {
  await User.query()
    .Driver.insert()
    .into(AUTHZ_ASSIGNMENT_TABLE)
    .values({ id: uuidv4(), subject_role: '', scope_id: '', tags: '', expires_at: null, granted_by: null, source: 'test', created_at: new Date(), ...row });
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

    it('removes the inserted account when its roles fail to be written after the dry run', async () => {
      const execute = DefaultAuthzAdmin.prototype.execute;
      const stub = sinon.stub(DefaultAuthzAdmin.prototype, 'execute').callsFake(function (this: DefaultAuthzAdmin, ...args: Parameters<DefaultAuthzAdmin['execute']>) {
        return args[2]?.dryRun ? execute.apply(this, args) : Promise.reject(new Error('assignment store down'));
      });

      await expect(create('rollback@spinajs.pl', 'rollback', ['user'], { password: 'passw0rd123', metadata: { 'user:phone': '123' } })).to.be.rejectedWith('assignment store down');
      expect(await User.query().withDeleted().whereLogin('rollback').first(), 'no row, not even a soft-deleted one').to.not.exist;

      stub.restore();
      const { User: u } = await create('rollback@spinajs.pl', 'rollback', ['user'], { password: 'passw0rd123' });
      expect(await globalRolesOf(u.Uuid)).to.deep.eq(['user']);
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

      expect(err.fieldName).to.eq('role');
      expect(err.errorCode).to.eq('unknown_role');
    });

    it('grant leaves a held GLOBAL assignment as it is, expiry and tags included', async () => {
      const expiresAt = new Date(Date.now() + 24 * 3600 * 1000);
      await (await rootAdmin()).assign(SYSTEM, { subject: { type: 'user', id: TEST_USER_UUID }, role: 'editor', scope: GLOBAL, tags: ['trial'], expiresAt });

      await grant('test@spinajs.pl', 'editor');

      const store = (await DI.resolve(AssignmentStore)) as AssignmentStore;
      const [row] = (await store.forSubjects([{ type: 'user', id: TEST_USER_UUID }], new Date())).filter((a) => a.role === 'editor');
      expect(row.expiresAt?.getTime()).to.eq(expiresAt.getTime());
      expect(row.tags).to.deep.eq(['trial']);
    });

    it("grant with an actor runs AuthzAdmin's guard: no escalation", async () => {
      const { User: assigner } = await create('assigner@spinajs.pl', 'assigner', ['assigner'], { password: 'passw0rd123' });
      const actor = userPrincipal(assigner.Uuid);

      const target = new User({ Email: 'target@spinajs.pl', Login: 'target', Password: 'x', IsActive: true });
      await target.insert();

      await grant('target@spinajs.pl', 'editor', actor);
      const err = await adminFailure(grant('target@spinajs.pl', 'admin', actor));

      expect(err.code).to.eq('escalation');
      expect(await globalRolesOf(target.Uuid)).to.deep.eq(['editor']);
    });

    it('grant with an actor goes through AuthzAdmin even for a held role, so it reveals nothing to an unprivileged caller', async () => {
      const { User: plain } = await create('plain-actor@spinajs.pl', 'plain-actor', ['user'], { password: 'passw0rd123' });

      const err = await adminFailure(grant('test@spinajs.pl', 'admin', userPrincipal(plain.Uuid)));

      expect(err.code).to.eq('forbidden');
    });

    it("revoke with an actor runs AuthzAdmin's guard (self lockout); as SYSTEM it does not", async () => {
      const err = await adminFailure(revoke('test@spinajs.pl', 'admin', userPrincipal(TEST_USER_UUID)));

      expect(err.code).to.eq('self_lockout');
      expect(await globalRolesOf(TEST_USER_UUID)).to.include('admin');

      await revoke('test@spinajs.pl', 'admin');
      expect(await globalRolesOf(TEST_USER_UUID)).to.not.include('admin');
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
      const admins = (await getUsersByRole(['admin'])).map((x) => x.Login);
      expect(admins).to.include('test');
      expect(admins, 'a soft-deleted holder').to.not.include('test-deleted');
    });

    it('getUsersByRole ignores an assignment at another scope', async () => {
      const u = new User({ Email: 'scoped@spinajs.pl', Login: 'scoped', Password: 'x', IsActive: true });
      await u.insert();
      await (await rootAdmin()).assign(SYSTEM, { subject: { type: 'user', id: u.Uuid }, role: 'normal', scope: { type: 'project', id: 'p1' } });

      expect(await getUsersByRole(['normal'])).to.deep.eq([]);
    });

    it('getUsersByRole leaves out expired, scoped and subject-set rows', async () => {
      const u = new User({ Email: 'excluded@spinajs.pl', Login: 'excluded', Password: 'x', IsActive: true });
      await u.insert();
      await insertAssignmentRow({ subject_type: 'user', subject_id: u.Uuid, role: 'editor', scope_type: GLOBAL.type, expires_at: new Date(Date.now() - 3600 * 1000) });
      await insertAssignmentRow({ subject_type: 'user', subject_id: u.Uuid, role: 'editor', scope_type: 'project', scope_id: 'p1' });
      // A subject set whose scope is this user's own ref: only the subject_role filter leaves it out.
      await insertAssignmentRow({ subject_type: 'user', subject_id: u.Uuid, subject_role: 'group.member', role: 'editor', scope_type: GLOBAL.type });

      expect(await getUsersByRole(['editor'])).to.deep.eq([]);
    });
  });
});
