/* eslint-disable @typescript-eslint/no-floating-promises */
import { Configuration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from './../src/index.js';
import { ConnectionConf, db } from './common.js';
import { CompositeKeyModel } from './models/CompositeKeyModel.js';
import { CompositeChild } from './models/CompositeChild.js';

// @Migration registers into DI at IMPORT time. Without this the migration is invisible when
// this file runs on its own and every table is missing.
import './migrations/TestMigration_2022_02_08_01_13_00.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

describe('Sqlite - composite primary keys', function () {
  this.timeout(15000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Orm);
    await db().migrateUp();
    await db().reloadTableInfo();
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('creates a table with a composite PRIMARY KEY constraint', async () => {
    const info = await db().Connections.get('sqlite')!.tableInfo('composite_key_model');
    const pkCols = info!.filter((c) => c.PrimaryKey).map((c) => c.Name);

    expect(pkCols).to.deep.equal(['TenantId', 'Code']);
    // PRAGMA table_info reports `pk` as the 1-based POSITION in the key, so the old
    // `r.pk === 1 && type === 'INTEGER'` wrongly flagged the first column as auto-increment.
    expect(info!.find((c) => c.Name === 'TenantId')!.AutoIncrement).to.equal(false);
  });

  it('inserts and reads back a composite-key row', async () => {
    const m = new CompositeKeyModel({ TenantId: 1, Code: 'a', Name: 'first' });
    await m.insert();

    const found = await CompositeKeyModel.get([1, 'a']);
    expect(found).to.be.not.null;
    expect(found.Name).to.equal('first');
  });

  it('distinguishes rows that share the first key column', async () => {
    await new CompositeKeyModel({ TenantId: 1, Code: 'a', Name: 'A' }).insert();
    await new CompositeKeyModel({ TenantId: 1, Code: 'b', Name: 'B' }).insert();

    expect((await CompositeKeyModel.get([1, 'a'])).Name).to.equal('A');
    expect((await CompositeKeyModel.get([1, 'b'])).Name).to.equal('B');
  });

  it('find() returns exactly the named tuples', async () => {
    await new CompositeKeyModel({ TenantId: 1, Code: 'a', Name: 'A' }).insert();
    await new CompositeKeyModel({ TenantId: 1, Code: 'b', Name: 'B' }).insert();
    await new CompositeKeyModel({ TenantId: 2, Code: 'a', Name: 'C' }).insert();

    const rows = await CompositeKeyModel.find([[1, 'a'], [2, 'a']]);
    expect(rows.map((r) => r.Name).sort()).to.deep.equal(['A', 'C']);
  });

  it('update() targets one row only', async () => {
    await new CompositeKeyModel({ TenantId: 1, Code: 'a', Name: 'A' }).insert();
    await new CompositeKeyModel({ TenantId: 1, Code: 'b', Name: 'B' }).insert();

    const m = await CompositeKeyModel.get([1, 'a']);
    m.Name = 'A2';
    await m.update();

    expect((await CompositeKeyModel.get([1, 'a'])).Name).to.equal('A2');
    expect((await CompositeKeyModel.get([1, 'b'])).Name).to.equal('B');
  });

  it('destroy() deletes one row only', async () => {
    await new CompositeKeyModel({ TenantId: 1, Code: 'a', Name: 'A' }).insert();
    await new CompositeKeyModel({ TenantId: 1, Code: 'b', Name: 'B' }).insert();

    await CompositeKeyModel.destroy([[1, 'a']]);

    expect(await CompositeKeyModel.get([1, 'a'])).to.be.undefined;
    expect((await CompositeKeyModel.get([1, 'b'])).Name).to.equal('B');
  });

  it('batches a hasMany relation off the named join column', async () => {
    await new CompositeKeyModel({ TenantId: 1, Code: 'a', Name: 'A' }).insert();
    await new CompositeChild({ tenant_id: 1, Val: 'c1' }).insert();
    await new CompositeChild({ tenant_id: 1, Val: 'c2' }).insert();

    const rows = await CompositeKeyModel.where('TenantId', 1).populate('Children');
    expect(rows[0].Children.map((c) => c.Val).sort()).to.deep.equal(['c1', 'c2']);
  });

  it('orphan-deletes children of a composite-key owner without touching other owners', async () => {
    await new CompositeKeyModel({ TenantId: 1, Code: 'a', Name: 'A' }).insert();
    await new CompositeChild({ tenant_id: 1, Val: 'keep' }).insert();
    await new CompositeChild({ tenant_id: 1, Val: 'drop' }).insert();
    await new CompositeChild({ tenant_id: 2, Val: 'other' }).insert();

    const owner = (await CompositeKeyModel.where('TenantId', 1).populate('Children'))[0];
    owner.Children.remove((c) => c.Val === 'drop');
    await owner.Children.sync();

    const remaining = await CompositeChild.all();
    expect(remaining.map((c) => c.Val).sort()).to.deep.equal(['keep', 'other']);
  });
});
