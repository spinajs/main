import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';
import { OrmDriver } from '@spinajs/orm';

import { AuthzRbacDropUserRole_2026_10_01_00_02_00, AuthzRbacUserRoles_2026_10_01_00_01_00 } from '../../src/index.js';
import { bootDb, TestDb } from '../support/db.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const COPY = 'AuthzRbacUserRoles_2026_10_01_00_01_00';
const DROP = 'AuthzRbacDropUserRole_2026_10_01_00_02_00';

const refusal = (migration: string) => new RegExp(`^${migration}: the authz tables are on connection "l2-elsewhere-second" \\(db\\.Aliases\\.authz\\), but the users\\.Role migrations run on the default connection "l2-elsewhere".*set db\\.Aliases\\.authz to the default connection`);

async function createUsers(driver: OrmDriver, role = true): Promise<void> {
  await driver.schema().createTable('users', (table) => {
    table.int('Id').primaryKey().autoIncrement();
    table.string('Uuid', 36).notNull();
    if (role) table.string('Role', 256).notNull();
  });
}

async function seedUsers(driver: OrmDriver, roles: (string | undefined)[]): Promise<void> {
  for (let i = 0; i < roles.length; i++) {
    await driver
      .insert()
      .into('users')
      .values({ Uuid: `u${i + 1}`, ...(roles[i] === undefined ? {} : { Role: roles[i] }) });
  }
}

const columns = async (driver: OrmDriver) => ((await driver.tableInfo('users')) ?? []).map((c) => c.Name);
const assignmentsOn = async (driver: OrmDriver) => (await driver.select().from('authz_assignment')) as unknown[];

describe('the users.Role migrations with db.Aliases.authz on another connection (sqlite)', function () {
  this.timeout(60_000);

  let db: TestDb | undefined;

  beforeEach(async function () {
    db = await bootDb(this, 'sqlite', 'elsewhere', { migrate: false, second: true, authzOnSecond: true });
  });

  afterEach(async () => {
    await db?.dispose();
    db = undefined;
  });

  it('the copy refuses before it writes when there are roles to copy', async () => {
    await createUsers(db!.driver);
    await seedUsers(db!.driver, ['admin', '']);

    await expect(new AuthzRbacUserRoles_2026_10_01_00_01_00().up(db!.driver)).to.be.rejectedWith(AuthzConfigError, refusal(COPY));

    expect(await assignmentsOn(db!.second!)).to.deep.eq([]);
    expect(await db!.driver.schema().tableExists('authz_assignment')).to.eq(false);
  });

  it('the copy and the drop run when there are no users to read', async () => {
    await createUsers(db!.driver);

    await db!.orm.Migration.up();

    expect(await columns(db!.driver)).to.deep.eq(['Id', 'Uuid']);
    expect(await assignmentsOn(db!.second!)).to.deep.eq([]);
  });

  it('the drop refuses, changing nothing, when it would check users against authz_assignment', async () => {
    await createUsers(db!.driver);
    await seedUsers(db!.driver, ['admin']);

    await expect(new AuthzRbacDropUserRole_2026_10_01_00_02_00().up(db!.driver)).to.be.rejectedWith(AuthzConfigError, refusal(DROP));

    expect(await columns(db!.driver)).to.deep.eq(['Id', 'Uuid', 'Role']);
  });

  it('the drop down() refuses, changing nothing, when it would fill the column from authz_assignment', async () => {
    await createUsers(db!.driver, false);
    await seedUsers(db!.driver, [undefined]);

    await expect(new AuthzRbacDropUserRole_2026_10_01_00_02_00().down(db!.driver)).to.be.rejectedWith(AuthzConfigError, refusal(DROP));

    expect(await columns(db!.driver)).to.deep.eq(['Id', 'Uuid']);
  });

  it('the copy down() refuses', async () => {
    await expect(new AuthzRbacUserRoles_2026_10_01_00_01_00().down(db!.driver)).to.be.rejectedWith(AuthzConfigError, refusal(COPY));
  });
});
