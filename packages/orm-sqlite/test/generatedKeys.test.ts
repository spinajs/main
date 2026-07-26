/* eslint-disable @typescript-eslint/no-floating-promises */
import { Configuration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import { Orm, IInsertResult, ServerResponseMapper } from '@spinajs/orm';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from './../src/index.js';
import { ConnectionConf, db } from './common.js';
import { AutoKeyModel } from './models/AutoKeyModel.js';
import { UuidKeyModel } from './models/UuidKeyModel.js';
import { AssignedKeyModel } from './models/AssignedKeyModel.js';

// @Migration registers into DI at IMPORT time; without this the tables never exist.
import './migrations/TestMigration_2022_02_08_01_13_00.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

describe('Sqlite - generated primary keys', function () {
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

  it('auto: the model learns the identity value from its own insert', async () => {
    const m = new AutoKeyModel({ Name: 'a' });
    await m.insert();

    expect(m.Id).to.be.a('number');
    expect(m.Id).to.be.greaterThan(0);
    expect((await AutoKeyModel.get(m.Id)).Name).to.equal('a');
  });

  it('uuid: the key exists before insert and survives the round-trip', async () => {
    const m = new UuidKeyModel({ Name: 'c' });
    const before = m.Id;

    expect(before).to.match(/^[0-9a-f]{8}-/);

    await m.insert();
    expect(m.Id).to.equal(before);
    expect((await UuidKeyModel.get(before)).Name).to.equal('c');
  });

  it('uuid: LastInsertId is not written over the generated key', async () => {
    const m = new UuidKeyModel({ Name: 'd' });
    const before = m.Id;
    await m.insert();

    expect(m.Id).to.equal(before);
    expect(m.Id).to.not.equal(0);
  });

  it('assigned: a supplied key round-trips', async () => {
    const m = new AssignedKeyModel({ Code: 'K1', Name: 'e' });
    await m.insert();

    expect((await AssignedKeyModel.get('K1')).Name).to.equal('e');
  });

  it('assigned: inserting without a key throws before touching the database', async () => {
    const m = new AssignedKeyModel({ Name: 'f' } as any);

    await expect(m.insert()).to.be.rejectedWith(/must be assigned/);
    expect(await AssignedKeyModel.all()).to.have.length(0);
  });

  it('a plain insert result carries RowsAffected, LastInsertId and an empty Returning', async () => {
    const driver = db().Connections.get('sqlite')!;
    const result = (await driver.insert().into('auto_key_model').values({ Name: 'shape' })) as IInsertResult;

    expect(result.RowsAffected).to.equal(1);
    expect(result.LastInsertId).to.be.greaterThan(0);
    expect(result.Returning).to.deep.equal([]);
  });

  it('the response mapper normalizes a plain insert response', () => {
    const mapper = db().Connections.get('sqlite')!.Container.resolve(ServerResponseMapper);

    expect(mapper.read({ RowsAffected: 1, LastInsertId: 7 }, ['Id'])).to.deep.equal({
      RowsAffected: 1,
      LastInsertId: 7,
      Returning: [],
    });
  });

  it('the response mapper reads the key out of RETURNING rows', () => {
    const mapper = db().Connections.get('sqlite')!.Container.resolve(ServerResponseMapper);

    expect(mapper.read([{ Id: 3, Name: 'x' }], ['Id'])).to.deep.equal({
      RowsAffected: 1,
      LastInsertId: 3,
      Returning: [{ Id: 3, Name: 'x' }],
    });
  });

  it('the response mapper reports LastInsertId 0 for a non-numeric key', () => {
    const mapper = db().Connections.get('sqlite')!.Container.resolve(ServerResponseMapper);

    expect(mapper.read([{ Id: 'aaaa-bbbb' }], ['Id']).LastInsertId).to.equal(0);
  });
});
