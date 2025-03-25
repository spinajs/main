/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-floating-promises */
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver } from './../src/index.js';
import { Bootstrapper, DI } from '@spinajs/di';
import { Dataset, ModelBase, Orm } from '@spinajs/orm';
import _ from 'lodash';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import '@spinajs/log';
import { ConnectionConf, db } from './common.js';
import { DataSet, SetItem } from './models/Relation.js';
import sinon from 'sinon';
import { Location as LocationModel } from './models/Location.js';
import { LocationNetwork } from './models/LocationNetwork.js';
import { LocationNetworkMetadata } from './models/LocationNetworkMetadata.js';

const expect = chai.expect;
chai.use(chaiAsPromised);
describe('Sqlite - relations test', function () {
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

  it('should find diff  in oneToMany', async () => {
    await db();

    const dataset = [
      new SetItem({
        Val: 10,
      }),
      new SetItem({
        Val: 13,
      }),
    ];

    const set = await DataSet.where({ Id: 1 }).populate('Dataset').first();
    set.Dataset.set(Dataset.diff(dataset, (a, b) => a.Val === b.Val));

    await set.Dataset.sync();

    const result = await SetItem.where({ dataset_id: 1 });

    expect(result.length).to.eq(3);
    expect(result[0].Val).to.eq(11);
    expect(result[1].Val).to.eq(12);
    expect(result[2].Val).to.eq(13);
  });

  it('should set in oneToMany', async () => {
    await db();

    const dataset = [
      new SetItem({
        Val: 10,
      }),
      new SetItem({
        Val: 13,
      }),
    ];

    const set = await DataSet.where({ Id: 1 }).populate('Dataset').first();

    set.Dataset.set(dataset);

    await set.Dataset.sync();

    expect(set.Dataset.length).to.eq(2);
    expect(set.Dataset[0].Val).to.eq(10);
    expect(set.Dataset[1].Val).to.eq(13);

    const result = await SetItem.where({ dataset_id: 1 });

    expect(result.length).to.eq(2);
  });

  it('should find intersection in oneToMany', async () => {
    await db();

    const dataset = [
      new SetItem({
        Val: 10,
        Id: 1,
      }),
      new SetItem({
        Val: 13,
      }),
    ];

    const set = await DataSet.where({ Id: 1 }).populate('Dataset').first();

    expect(set.Dataset.length).to.eq(3);

    set.Dataset.set(Dataset.intersection(dataset));

    expect(set.Dataset.length).to.eq(1);
    expect(set.Dataset[0].Val).to.eq(10);

    await set.Dataset.sync();

    const result = await SetItem.where({ dataset_id: 1 });

    expect(result.length).to.eq(1);
  });

  it('Should union two relations  in oneToMany', async () => {
    await db();

    const dataset = [
      new SetItem({
        Val: 14,
      }),
      new SetItem({
        Val: 13,
      }),
    ];

    const set = await DataSet.where({ Id: 1 }).populate('Dataset').first();

    set.Dataset.union(dataset);

    await set.Dataset.sync();

    expect(set.Dataset.length).to.eq(5);
    expect(set.Dataset[0].Val).to.eq(10);
    expect(set.Dataset[1].Val).to.eq(11);
    expect(set.Dataset[2].Val).to.eq(12);
    expect(set.Dataset[3].Val).to.eq(14);
    expect(set.Dataset[4].Val).to.eq(13);

    await set.Dataset.sync();

    const result = await SetItem.where({ dataset_id: 1 });

    expect(result.length).to.eq(5);
  });

  it('Should sync only dirty models', async () => {
    const sb = sinon.createSandbox();
    sb.spy(ModelBase.prototype);

    const set = await DataSet.where({ Id: 1 }).populate('Dataset').first();
    const spy = set.Dataset[0].insert as any as sinon.SinonSpy;
    await set.Dataset.sync();
    expect(spy.called).to.be.false;
    expect(spy.callCount).to.eq(0);

    set.Dataset[0].Val = 100;

    await set.Dataset.sync();

    expect(spy.called).to.be.true;
    expect(spy.callCount).to.eq(1);
  });

  it('Static method populate on oneToMany', async () => {
    const network = await LocationModel.populate<typeof LocationNetwork>("Network", 1).first();
    expect(network).to.be.not.null;
    expect(network.Id).to.eq(1);
    expect(network.Name).to.eq('Network 1');

  });

  it('Static method populate on OneToOne', async () => {  
    const location = await LocationNetwork.populate<typeof LocationNetworkMetadata>("Metadata", 1);
    expect(location).to.be.not.null;
    expect(location.length).to.eq(2);
    expect(location[0].Key).to.eq('meta 1');
    expect(location[1].Key).to.eq('meta 2');
  });
});
