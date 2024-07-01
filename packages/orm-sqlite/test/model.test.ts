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

  
it('Should set filterable columns in descriptor', async () => {
    await db();

    const columns = Location.filterColumns();

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

  it('Should return fileterable column schema', async () => {
    await db();

    const schema = Model1.filterSchema();
    expect(schema).to.be.not.null;
  });


});

