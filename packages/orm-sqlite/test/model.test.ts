/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-floating-promises */
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver } from './../src/index.js';
import { Bootstrapper, DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import _ from 'lodash';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import '@spinajs/log';
import { ConnectionConf, db } from './common.js';
import { Location as LocationModel } from './models/Location.js';
import '@spinajs/orm-http';

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

  it('Should populate nested relations in . format', async () =>{ 

    const locs = await LocationModel.where("Id", 1).populate("Network.Metadata");
    expect(locs).to.be.not.null;
    expect(locs).to.be.an('array');
    expect(locs).to.have.lengthOf(1);
    expect(locs[0].Network).to.be.not.null;
    expect(locs[0].Network.Value).to.be.not.null;
    expect(locs[0].Network.Value.Name).to.be.eq('Network  1');
    expect(locs[0].Network.Value.Metadata).to.be.not.null;
    expect(locs[0].Network.Value.Metadata).to.be.an('array');
    expect(locs[0].Network.Value.Metadata).to.have.lengthOf(2);
    expect(locs[0].Network.Value.Metadata[0].Key).to.be.eq('meta 1');
    expect(locs[0].Network.Value.Metadata[1].Key).to.be.eq('meta 2');
  });

   
  it('whereExists should return true on query builder', async () => {

    await db();
    const exists = await LocationModel.query().whereExist('Metadata');
    expect(exists).to.be.not.null;
    expect(exists).to.be.an('array');
    expect(exists).to.have.lengthOf(2);

  });

  it('whereExists should return true if relation exists ( static )', async () => {
    await db();
    const exists = await LocationModel.whereExists('Metadata');
    expect(exists).to.be.not.null;
    expect(exists).to.be.an('array');
    expect(exists).to.have.lengthOf(2);
  });

  it('whereExists should return true if relation exists with condition ( static )', async () => {
    await db();
    const exists = await LocationModel.whereExists('Metadata', function() { 
      this.where('Key', 'meta 1');
    });
    expect(exists).to.be.not.null;
    expect(exists).to.be.an('array');
    expect(exists).to.have.lengthOf(1);
  });

  it('whereExists should return false if relation does not exists ( static )', async () => {
    await db();
    const exists = await LocationModel.whereExists('Metadata', function() { 
      this.where('Key', 'meta 3');
    });
    expect(exists).to.be.an('array');
    expect(exists).to.have.lengthOf(0);
  });
});
