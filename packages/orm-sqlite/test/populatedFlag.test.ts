/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Configuration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';
import { DataSet } from './models/Relation.js';
import { Offer } from './models/Offer.js';
import { Location as LocationModel } from './models/Location.js';
import './migrations/TestMigration_2022_02_08_01_13_00.js';

describe('Populated flag', function () {
  this.timeout(10000);

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

  it('is false on a freshly constructed model', () => {
    const d = new DataSet();
    expect(d.Dataset.Populated).to.equal(false);
  });

  it('is true for an eagerly populated hasMany', async () => {
    const d = await DataSet.where({ Id: 1 }).populate('Dataset').first();
    expect(d.Dataset.length).to.be.greaterThan(0);
    expect(d.Dataset.Populated).to.equal(true);
  });

  it('is false for a hasMany that was not populated', async () => {
    const d = await DataSet.where({ Id: 1 }).first();
    expect(d.Dataset.Populated).to.equal(false);
  });

  it('is true for an eagerly populated manyToMany', async () => {
    const o = await Offer.where({ Id: 1 }).populate('Localisations').first();
    expect(o.Localisations.length).to.be.greaterThan(0);
    expect(o.Localisations.Populated).to.equal(true);
  });

  it('is true for an eagerly populated belongsTo', async () => {
    const l = await LocationModel.where({ Id: 1 }).populate('Network').first();
    expect((l.Network as any).Value).to.not.equal(undefined);
    expect(l.Network.Populated).to.equal(true);
  });

  it('is false for a belongsTo that was not populated', async () => {
    const l = await LocationModel.where({ Id: 1 }).first();
    expect(l.Network.Populated).to.equal(false);
  });

  it('stays true after the lazy populate() path', async () => {
    const d = await DataSet.where({ Id: 1 }).first();
    await d.Dataset.populate();
    expect(d.Dataset.Populated).to.equal(true);
  });
});
