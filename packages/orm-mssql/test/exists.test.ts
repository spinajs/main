/* eslint-disable @typescript-eslint/require-await */
import 'mocha';
import * as chai from 'chai';
import _ from 'lodash';

import '@spinajs/log';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { ICompilerOutput, IColumnDescriptor, Orm, OrmDriver, SelectQueryBuilder } from '@spinajs/orm';

import { MsSqlOrmDriver } from '../src/index.js';
import { mergeArrays } from './util.js';
import { ExistsItem } from './models/exists.js';

const expect = chai.expect;

/**
 * The real driver with the database taken out, so a model query compiles to T-SQL without a
 * server.
 */
class FakeMsSqlDriver extends MsSqlOrmDriver {
  public async executeOnDb(): Promise<any> {
    return [];
  }

  public async ping(): Promise<boolean> {
    return true;
  }

  public async connect(): Promise<OrmDriver> {
    return this;
  }

  public async disconnect(): Promise<OrmDriver> {
    return this;
  }

  public async tableInfo(): Promise<IColumnDescriptor[]> {
    return null as any;
  }
}

class ExistsConnectionConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: {
          targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
          rules: [{ name: '*', level: 'trace', target: 'Empty' }],
        },
        db: {
          Connections: [{ Driver: 'orm-driver-mssql-exists-fake', Name: 'mssql-exists', Database: 'test' }],
        },
      },
      mergeArrays,
    );
  }
}

function compiled(query: { toDB(): unknown }) {
  return ((query.toDB() as ICompilerOutput).expression as string).replace(/\s+/g, ' ').trim();
}

const byId = function (this: any) {
  this.where('id', '=', '42');
};

describe('mssql whereExist correlation', function () {
  this.timeout(15000);

  beforeEach(async () => {
    DI.clearCache();
    DI.register(ExistsConnectionConf).as(Configuration);
    DI.register(FakeMsSqlDriver).as('orm-driver-mssql-exists-fake');
    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('quotes a belongsTo correlation with brackets', () => {
    const stmt = compiled(ExistsItem.select().whereExist('Owner', byId));

    expect(stmt).to.contain('EXISTS (');
    expect(stmt).to.contain('[account_exists].[id] = [model].[user_id]');
  });

  it('quotes a belongsTo correlation against the outer alias', () => {
    const stmt = compiled(ExistsItem.select().setAlias('m').whereNotExists('Owner', byId));

    expect(stmt).to.contain('NOT EXISTS (');
    expect(stmt).to.contain('[account_exists].[id] = [m].[user_id]');
  });

  it('quotes a hasMany correlation with brackets', () => {
    const stmt = compiled(ExistsItem.select().whereNotExists('Notes', byId));

    expect(stmt).to.contain('NOT EXISTS (');
    expect(stmt).to.contain('[note_exists].[item_id] = [model].[id]');
  });

  it('quotes a many-to-many correlation with brackets', () => {
    const stmt = compiled(ExistsItem.select().whereExist('Tags', byId));

    expect(stmt).to.contain('EXISTS (');
    expect(stmt).to.contain('WHERE [item_tag_exists].[item_id] = [model].[id]');
  });
});

describe('mssql identifier quoting', function () {
  this.timeout(15000);

  beforeEach(async () => {
    DI.clearCache();
    DI.register(ExistsConnectionConf).as(Configuration);
    DI.register(FakeMsSqlDriver).as('orm-driver-mssql-exists-fake');
    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('quotes the FROM table, the join tables, the ON keys and the ORDER BY with brackets', () => {
    const connection = DI.get(Orm)!.Connections.get('mssql-exists')!;
    const qb = connection.Container.resolve<SelectQueryBuilder>(SelectQueryBuilder, [connection]).select('*').from('users');
    const result = qb.leftJoin({ joinTable: 'adresses', joinTableAlias: 'adresses', joinTableForeignKey: 'addressId', sourceTablePrimaryKey: 'id', joinTableDriver: qb.Driver }).orderBy('name').toDB();

    expect(result.expression).to.equal('SELECT [#users#].* FROM [users] as [#users#] LEFT JOIN [test].[adresses] as [adresses] ON [#users#].[id] = [adresses].[addressId] ORDER BY [name] ASC');
    expect(result.expression).to.not.contain('`');
  });
});
