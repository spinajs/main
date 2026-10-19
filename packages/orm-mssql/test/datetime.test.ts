/* eslint-disable @typescript-eslint/require-await */
import 'mocha';
import * as chai from 'chai';
import _ from 'lodash';
import { DateTime } from 'luxon';

import '@spinajs/log';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { Connection, DateTime as DateTimeColumn, ICompilerOutput, IColumnDescriptor, Model, ModelBase, Orm, OrmDriver, Primary, _prepareColumnDesc } from '@spinajs/orm';

import { MsSqlOrmDriver } from '../src/index.js';
import { mergeArrays } from './util.js';

const expect = chai.expect;

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
    return [_prepareColumnDesc({ Name: 'Id', Type: 'int', NativeType: 'int', PrimaryKey: true, AutoIncrement: true }), _prepareColumnDesc({ Name: 'At', Type: 'datetime2', NativeType: 'datetime2', Nullable: true })];
  }
}

class DatetimeConnectionConf extends FrameworkConfiguration {
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
          Connections: [{ Driver: 'orm-driver-mssql-datetime-fake', Name: 'mssql-datetime', Database: 'test' }],
        },
      },
      mergeArrays,
    );
  }
}

@Connection('mssql-datetime')
@Model('gap_doc')
class GapDoc extends ModelBase {
  @Primary()
  public Id: number;

  @DateTimeColumn()
  public At: DateTime;
}

function bindings(query: { toDB(): unknown }) {
  return (query.toDB() as ICompilerOutput).bindings;
}

describe('mssql datetime strings', function () {
  this.timeout(15000);

  const expected = DateTime.local(2024, 1, 1, 10, 0, 0).toISO({ includeOffset: false });

  beforeEach(async () => {
    DI.clearCache();
    DI.register(DatetimeConnectionConf).as(Configuration);
    DI.register(FakeMsSqlDriver).as('orm-driver-mssql-datetime-fake');
    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('binds an ISO string in Model.update as the converted datetime', () => {
    expect(bindings(GapDoc.update({ At: '2024-01-01T10:00:00' as unknown as DateTime }).where('Id', 1))).to.deep.eq([expected, 1]);
  });

  it('binds an SQL-format string in Model.update as the converted datetime', () => {
    expect(bindings(GapDoc.update({ At: '2024-01-01 10:00:00' as unknown as DateTime }).where('Id', 1))).to.deep.eq([expected, 1]);
  });

  it('rejects a string that is not a datetime instead of writing NULL', () => {
    expect(() => GapDoc.update({ At: 'not a date' as unknown as DateTime })).to.throw(InvalidArgument, 'is not an ISO 8601 or SQL datetime');
  });

  it('binds converted ISO strings in whereIn', () => {
    expect(bindings(GapDoc.query().whereIn('At', ['2024-01-01T10:00:00', '2024-01-01T10:00:00Z']))).to.deep.eq([expected, DateTime.fromISO('2024-01-01T10:00:00Z').toISO({ includeOffset: false })]);
  });
});
