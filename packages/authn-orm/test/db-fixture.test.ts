import { expect } from 'chai';
import 'mocha';

import { Configuration } from '@spinajs/configuration';
import { OrmDriver, OrmMigration } from '@spinajs/orm';

import { bootDb, TestDb } from './support/db.js';

class FixtureExtra_2026_10_02_00_00_01 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('n4_fixture_extra', (table) => {
      table.string('id', 36).notNull().primaryKey();
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('n4_fixture_extra');
  }
}

describe('test fixture bootDb (sqlite)', function () {
  this.timeout(30000);

  let withExtra: TestDb;
  let plain: TestDb;

  before(async function () {
    withExtra = await bootDb(this, 'sqlite', 'fixture_extra', { migrations: [FixtureExtra_2026_10_02_00_00_01], config: { authn: { mfa: { encryptionKey: { secret: 'k' } } } } });
    plain = await bootDb(this, 'sqlite', 'fixture_plain');
  });

  after(async () => {
    await withExtra?.dispose();
    await plain?.dispose();
  });

  it('runs extra migrations for that boot only, next to AuthnInitial', async () => {
    expect(await withExtra.driver.schema().tableExists('n4_fixture_extra')).to.eq(true);
    expect(await withExtra.driver.schema().tableExists('authn_identity')).to.eq(true);

    expect(await plain.driver.schema().tableExists('n4_fixture_extra')).to.eq(false);
    expect(await plain.driver.schema().tableExists('authn_identity')).to.eq(true);
  });

  it('merges extra configuration into the child container only', async () => {
    const withCfg = await withExtra.container.resolve(Configuration);
    const plainCfg = await plain.container.resolve(Configuration);

    expect(withCfg.get('authn.mfa.encryptionKey.secret')).to.eq('k');
    expect(plainCfg.get('authn.mfa.encryptionKey.secret')).to.eq(undefined);
  });
});
