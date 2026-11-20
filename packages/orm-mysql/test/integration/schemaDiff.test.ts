/**
 * The schema diff against a live MySQL, for what only MySQL has: a prefix index.
 *
 *   npx ts-mocha -p tsconfig.json test/integration/schemaDiff.test.ts
 *
 * Connection settings come from ORM_TEST_MYSQL_* (see README).
 */
import { DI } from '@spinajs/di';
import { diffSchema, introspectSchema, isActionable, QueryContext, type DiffOptions, type TargetTable } from '@spinajs/orm';
import '@spinajs/log';
import { expect } from 'chai';
import 'mocha';
import { randomUUID } from 'node:crypto';

import { MySqlOrmDriver } from '../../src/index.js';

const SERVER = {
  Host: process.env.ORM_TEST_MYSQL_HOST ?? '127.0.0.1',
  Port: Number(process.env.ORM_TEST_MYSQL_PORT ?? 13306),
  User: process.env.ORM_TEST_MYSQL_USER ?? 'root',
  Password: process.env.ORM_TEST_MYSQL_PASSWORD ?? 'root',
};
const DATABASE = `orm_diff_${randomUUID().slice(0, 8)}`;

const members: TargetTable = {
  name: 'diff_members',
  columns: [
    { name: 'Id', sql: { family: 'integer', inferred: true }, nullable: false, primary: true },
    { name: 'Email', sql: { family: 'text', inferred: true }, nullable: true, primary: false },
  ],
  indexes: [{ columns: ['Email'], unique: false }],
  foreignKeys: [],
  exhaustive: false,
  models: ['Member'],
};

describe('schema diff on mysql (integration)', function () {
  this.timeout(60000);

  let admin: MySqlOrmDriver;
  let driver: MySqlOrmDriver;

  before(async () => {
    admin = await DI.child().resolve(MySqlOrmDriver, [{ Name: 'diff-admin', Driver: 'orm-driver-mysql', ...SERVER, Database: 'mysql' }]);
    await admin.connect();
    await admin.schema().createDatabase(DATABASE);
    driver = await DI.child().resolve(MySqlOrmDriver, [{ Name: 'diff', Driver: 'orm-driver-mysql', ...SERVER, Database: DATABASE }]);
    await driver.connect();
    await driver.schema().raw('CREATE TABLE diff_members (Id INT AUTO_INCREMENT PRIMARY KEY, Email VARCHAR(64), INDEX ix_diff_members_Email (Email(4)))');
  });

  after(async () => {
    await driver?.disconnect();
    await admin?.executeOnDb(`DROP DATABASE IF EXISTS \`${DATABASE}\``, [], QueryContext.Schema);
    await admin?.disconnect();
  });

  it('notes a prefix index that holds the name of a declared index (MIG007) and proposes nothing', async () => {
    const diagnostics: NonNullable<DiffOptions['diagnostics']> = [];
    const live = await introspectSchema(driver, ['diff_members']);
    const changes = diffSchema([members], live.columns, live.extras, { dialect: live.dialect, diagnostics });

    expect(changes.filter(isActionable)).to.deep.equal([]);
    expect(diagnostics.filter((d) => d.code === 'MIG007')).to.deep.equal([
      { code: 'MIG007', severity: 'info', message: 'index ix_diff_members_Email on diff_members is an expression or prefix index and cannot be compared; check it by hand' },
    ]);
  });
});
