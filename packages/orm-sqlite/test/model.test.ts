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

  it('Should set filterable columns in descriptor', async () => {
    await db();

    const columns = LocationModel.filterColumns();

    expect(columns.length).to.eq(2);
    expect(columns).to.containSubset([
      {
        column: 'Bar',
        operator: ['eq'],
      },
      {
        column: 'UpdatedAt',
        operator: ['gt'],
      },
    ]);
  });

  // it('Should return fileterable column schema', async () => {
  //   await db();

  //   const schema = LocationModel.filterSchema();
  //   expect(schema).to.be.not.null;
  // });

  it('whereExists should return true if relation exists', async () => {
    await db();
    const exists = await LocationModel.whereExists('Metadata');
    expect(exists).to.be.not.null;
    expect(exists).to.be.an('array');
    expect(exists).to.have.lengthOf(2);
  });

  it('whereExists should return true if relation exists with condition', async () => {
    await db();
    const exists = await LocationModel.whereExists('Metadata', function() { 
      this.where('Key', 'meta 1');
    });
    expect(exists).to.be.not.null;
    expect(exists).to.be.an('array');
    expect(exists).to.have.lengthOf(1);
  });

  it('whereExists should return false if relation does not exists', async () => {
    await db();
    const exists = await LocationModel.whereExists('Metadata', function() { 
      this.where('Key', 'meta 3');
    });
    expect(exists).to.be.an('array');
    expect(exists).to.have.lengthOf(0);
  });
});
