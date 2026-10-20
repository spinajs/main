import 'mocha';
import { expect } from 'chai';
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { DatetimeValueConverter, QueryContext } from '@spinajs/orm';
import { DateTime } from 'luxon';

import { PostgresOrmDriver } from '../src/index.js';

class CaptureDriver extends PostgresOrmDriver {
  public bound: unknown[] = [];

  protected async _executeOnDbOnce(_stmt: string, params: any[]): Promise<any> {
    this.bound = params;
    return [];
  }
}

describe('postgres raw statement parameters', function () {
  this.timeout(15000);

  let driver: CaptureDriver;

  beforeEach(async () => {
    driver = await DI.resolve(CaptureDriver, [{ Name: 'pg-raw-dates', Driver: 'orm-driver-postgres' } as any]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('writes a Date or DateTime through the datetime converter, other values as given', async () => {
    const at = new Date(Date.UTC(2026, 9, 19, 12, 0, 0, 123));
    const expected = driver.Container.resolve<DatetimeValueConverter>(DatetimeValueConverter).toDB(at, null as any, null as any);

    await driver.executeOnDb('SELECT ?, ?, ?, ?', [at, DateTime.fromJSDate(at), 'text', 7], QueryContext.Select);

    expect(expected).to.be.a('string');
    expect(driver.bound).to.deep.eq([expected, expected, 'text', 7]);
  });
});
