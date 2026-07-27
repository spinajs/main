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
import { DataSet, SetItem } from './models/Relation.js';
import { Offer } from './models/Offer.js';
import { Location as LocationModel } from './models/Location.js';
import './migrations/TestMigration_2022_02_08_01_13_00.js';

describe('snapshot capture', function () {
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

  it('a queried model has a snapshot and no changes', async () => {
    const item = await SetItem.where({ Id: 1 }).first();

    expect(item.Snapshot).to.not.equal(null);
    expect(item.IsDirty).to.equal(false);
    expect(item.changedColumns()).to.deep.equal([]);
  });

  it('the snapshot survives a mutation of the model', async () => {
    const item = await SetItem.where({ Id: 1 }).first();
    const before = item.Val;

    item.Val = before + 100;

    expect(item.Snapshot!.Columns.get('Val')).to.equal(before);
    expect(item.changedColumns()).to.deep.equal(['Val']);
  });

  it('children of a populated hasMany each have their own snapshot', async () => {
    const set = await DataSet.where({ Id: 1 }).populate('Dataset').first();

    expect(set.Dataset.length).to.equal(3);
    set.Dataset.forEach((c: any) => {
      expect(c.Snapshot, `child ${c.Id} has no snapshot`).to.not.equal(null);
      expect(c.changedColumns()).to.deep.equal([]);
    });
  });

  it('an eagerly populated hasMany records its member keys in the owner snapshot', async () => {
    const set = await DataSet.where({ Id: 1 }).populate('Dataset').first();

    const keys = set.Snapshot!.Relations.get('Dataset');
    expect(keys).to.not.equal(undefined);
    expect([...keys!].sort()).to.deep.equal(set.Dataset.map((x: any) => x.Id).sort());
  });

  it('an eagerly populated manyToMany records its member keys in the owner snapshot', async () => {
    const offer = await Offer.where({ Id: 1 }).populate('Localisations').first();

    const keys = offer.Snapshot!.Relations.get('Localisations');
    expect(keys).to.not.equal(undefined);
    expect([...keys!].sort()).to.deep.equal(offer.Localisations.map((x: any) => x.Id).sort());
  });

  it('an eagerly populated belongsTo records the target key in the owner snapshot', async () => {
    const loc = await LocationModel.where({ Id: 1 }).populate('Network').first();

    expect(loc.Snapshot!.Relations.get('Network')).to.deep.equal([(loc.Network as any).Value.Id]);
  });

  it('the lazy hasMany populate() records member keys too', async () => {
    const set = await DataSet.where({ Id: 1 }).first();
    await set.Dataset.populate();

    const keys = set.Snapshot!.Relations.get('Dataset');
    expect([...keys!].sort()).to.deep.equal(set.Dataset.map((x: any) => x.Id).sort());
  });

  it('the lazy manyToMany populate() records member keys too', async () => {
    const offer = await Offer.where({ Id: 1 }).first();
    await offer.Localisations.populate();

    const keys = offer.Snapshot!.Relations.get('Localisations');
    expect([...keys!].sort()).to.deep.equal(offer.Localisations.map((x: any) => x.Id).sort());
  });

  it('the lazy belongsTo populate() records the target key too', async () => {
    const loc = await LocationModel.where({ Id: 1 }).first();
    await loc.Network.populate();

    expect(loc.Snapshot!.Relations.get('Network')).to.deep.equal([(loc.Network as any).Value.Id]);
  });

  it('a model built with `new` has no snapshot even after populating a relation on it', async () => {
    const set = new DataSet();
    await set.Dataset.populate();

    expect(set.Snapshot).to.equal(null);
  });
});
