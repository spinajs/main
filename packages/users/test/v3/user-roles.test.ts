import { DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { expect } from 'chai';

import { User } from '../../src/index.js';
import { create } from '../../src/actions.js';
import { TEST_USER_UUID_2 } from '../migration/rbac.migration.js';
import { bootUsersDb, registerUsersTestHost, releaseUsersHost } from '../support/users-db.js';
import { globalRolesOf } from '../support/authz-host.js';
import { Configuration } from '@spinajs/configuration';

chai.use(chaiAsPromised);

// Ported from users legacy-v2/user.test.ts rows 13 and 14 (B11, B12, H13): roles are GLOBAL assignments, not a `Role` column.
describe('User roles', function () {
  this.timeout(30000);

  before(() => {
    registerUsersTestHost();
  });

  beforeEach(async () => {
    await bootUsersDb();
  });

  afterEach(() => {
    releaseUsersHost();
  });

  it('Should check if guest role is set by default', async () => {
    const user = new User({
      Email: 'test@test.pl',
      Login: 'tes t',
      IsActive: true,
      Password: 'test',
      Uuid: TEST_USER_UUID_2,
    });

    expect(user.Id).to.not.exist;

    await user.insert();

    // Changed (H13): a raw insert grants no role; there is no guest column default.
    const user2 = await User.get(user.Id);
    expect(user2.Id).to.eq(user.Id);
    expect(await globalRolesOf(user.Uuid)).to.deep.equal([]);

    // Changed (H13, B11): the default roles come from create(), as GLOBAL assignments of authz.rbac.defaultRoles.
    const defaults = DI.get(Configuration)!.get<string[]>('authz.rbac.defaultRoles', []);
    const { User: created } = await create({ Email: 'created@test.pl', Login: 'created', Password: 'passw0rd123' });
    expect(await globalRolesOf(created.Uuid)).to.deep.equal(defaults);
    expect(defaults.length).to.be.eq(1);
  });

  it('Should save multiple roles', async () => {
    const { User: user } = await create({ Email: 'test@test.pl', Login: 'test ddd', IsActive: true, Password: 'passw0rd123' } as any, ['admin', 'user']);

    const user2 = await User.get(user.Id);
    expect(await globalRolesOf(user2.Uuid)).to.have.members(['admin', 'user']);
    expect(await globalRolesOf(user2.Uuid)).to.have.length(2);
  });
});
