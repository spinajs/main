import { DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { InvalidArgument } from '@spinajs/exceptions';
import { DefaultQueueService } from '@spinajs/queue';
import { AuthzAdminFailure, GLOBAL, SYSTEM } from '@spinajs/authz';
import { AssignmentStore } from '@spinajs/authz-rbac';

import { User } from '../../src/index.js';
import { create } from '../../src/actions.js';
import { TEST_USER_UUID } from '../migration/rbac.migration.js';
import { bootUsersDb, registerUsersTestHost } from '../support/users-db.js';
import { globalRolesOf, rootAdmin } from '../support/authz-host.js';

chai.use(chaiAsPromised);

const subject = { type: 'user', id: TEST_USER_UUID };

async function refusal(p: Promise<unknown>): Promise<InvalidArgument> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).to.be.instanceOf(InvalidArgument);
  return err as InvalidArgument;
}

// Ported from users legacy-v2/actions.test.ts rows 41, 42, 82-85 (B11, B12, B27, B43): grant and revoke are
// AuthzAdmin.assign and revoke, create(user, roles?) writes GLOBAL assignments, no `User.Role`.
describe('role grants through AuthzAdmin', function () {
  this.timeout(30000);

  before(() => {
    registerUsersTestHost();
  });

  beforeEach(async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));
    await bootUsersDb();
  });

  afterEach(() => {
    sinon.restore();
    DI.clearCache();
  });

  it('Should grant role', async () => {
    expect(await globalRolesOf(TEST_USER_UUID)).to.not.include('editor');

    const admin = await rootAdmin();
    await admin.assign(SYSTEM, { subject, role: 'editor', scope: GLOBAL });

    expect(await globalRolesOf(TEST_USER_UUID)).to.include('editor');

    // Changed (B11): a second assign of a held GLOBAL role is the idempotent no-op the 2.x `grant` was; asserted as "never two rows".
    await admin.assign(SYSTEM, { subject, role: 'editor', scope: GLOBAL });
    expect((await globalRolesOf(TEST_USER_UUID)).filter((r) => r === 'editor')).to.have.lengthOf(1);
  });

  it('Should revoke role', async () => {
    const admin = await rootAdmin();
    const row = await admin.assign(SYSTEM, { subject, role: 'editor', scope: GLOBAL });
    expect(await globalRolesOf(TEST_USER_UUID)).to.include('editor');

    // Changed (B11, B43): revoke takes the assignment id, not a role name.
    await admin.revoke(SYSTEM, row.id);

    expect(await globalRolesOf(TEST_USER_UUID)).to.not.include('editor');
    expect(await globalRolesOf(TEST_USER_UUID)).to.include('admin');
  });

  it('Should trim and de-duplicate the role list', async () => {
    const { User: u } = await create({ Email: 'roles@wp.pl', Login: 'roleuser', Password: 'passw0rd123' }, ['admin', ' admin ', 'guest']);

    const roles = await globalRolesOf(u.Uuid);
    expect(roles).to.have.members(['admin', 'guest']);
    expect(roles, 'a duplicate would be checked twice by every downstream guard').to.have.lengthOf(2);
  });

  // Changed (B12): roles are optional. An empty or blank list falls back to authz.rbac.defaultRoles instead of the 2.x "At least one role" refusal.
  it('Should fall back to the default roles for a role list that names no role', async () => {
    const { User: none } = await create({ Email: 'noroles@wp.pl', Login: 'noroles', Password: 'passw0rd123' }, []);
    const { User: blank } = await create({ Email: 'blankroles@wp.pl', Login: 'blankroles', Password: 'passw0rd123' }, ['  ', '']);

    expect(await globalRolesOf(none.Uuid)).to.deep.eq(['user']);
    expect(await globalRolesOf(blank.Uuid)).to.deep.eq(['user']);
  });

  // Changed (B12, B43): the refusal is InvalidArgument from AuthzAdmin (errorCode unknown_role); its message no longer names rbac.grants.
  it('Should refuse a role that is not configured', async () => {
    const err = await refusal(create({ Email: 'bogus@wp.pl', Login: 'bogususer', Password: 'passw0rd123' }, ['not-a-role']));

    expect(err.errorCode).to.eq('unknown_role');
    expect(await User.query().whereAnything('bogus@wp.pl').first()).to.not.exist;
  });

  it('Should refuse granting a role that is not configured', async () => {
    const admin = await rootAdmin();

    // Changed (B12, B43): AuthzAdmin refuses with AuthzAdminFailure (code unknown_role); only create() maps it to InvalidArgument.
    const err = await admin.assign(SYSTEM, { subject, role: 'not-a-role', scope: GLOBAL }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).to.be.instanceOf(AuthzAdminFailure);
    expect((err as AuthzAdminFailure).code).to.eq('unknown_role');
    const store = (await DI.resolve(AssignmentStore)) as AssignmentStore;
    expect((await store.forSubjects([subject], new Date())).map((a) => a.role)).to.not.include('not-a-role');
  });
});
