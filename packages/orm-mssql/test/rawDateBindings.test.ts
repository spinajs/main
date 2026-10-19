import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { DatetimeValueConverter, QueryContext } from '@spinajs/orm';
import { DateTime } from 'luxon';

import { MsSqlOrmDriver } from '../src/index.js';

class CaptureDriver extends MsSqlOrmDriver {
  public inputs: unknown[] = [];

  public fakePool(): void {
    this._connectionPool = {
      request: () => ({
        input: (_name: string, value: unknown) => this.inputs.push(value),
        query: () => Promise.resolve({ recordset: [], rowsAffected: [0] }),
      }),
    } as any;
  }
}

describe('mssql raw statement parameters', function () {
  this.timeout(15000);

  let driver: CaptureDriver;

  beforeEach(async () => {
    driver = await DI.resolve(CaptureDriver, [{ Name: 'mssql-raw-dates', Driver: 'orm-driver-mssql' } as any]);
    driver.fakePool();
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('writes a Date through the datetime converter, other values as given', async () => {
    const at = new Date(Date.UTC(2026, 9, 19, 12, 0, 0, 123));
    const converter = driver.Container.resolve<DatetimeValueConverter>(DatetimeValueConverter);

    await driver.executeOnDb('SELECT ?, ?, ?, ?', [at, DateTime.fromJSDate(at), 'text', 7], QueryContext.Select);

    expect(driver.inputs).to.deep.eq([converter.toDB(at, null as any, null as any), converter.toDB(DateTime.fromJSDate(at), null as any, null as any), 'text', 7]);
  });
});
