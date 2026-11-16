import 'mocha';
import { expect } from 'chai';
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { DatetimeValueConverter, QueryContext } from '@spinajs/orm';
import { DateTime } from 'luxon';

import { MySqlOrmDriver } from '../src/index.js';

class CaptureDriver extends MySqlOrmDriver {
  public bound: unknown[] = [];

  protected _executeOnDbOnce(_stmt: string, params: any[]): Promise<any> {
    this.bound = params;
    return Promise.resolve([]);
  }
}

// 2026-10-01 00:00 in Warsaw (CEST): the start of a month there, still September in UTC
const AT = new Date(Date.UTC(2026, 8, 30, 22, 0, 0, 0));

async function converterOf(timeZone?: string) {
  const options = { Name: `mysql-tz-${timeZone ?? 'default'}`, Driver: 'orm-driver-mysql', ...(timeZone ? { TimeZone: timeZone } : {}) };
  const driver = await DI.resolve(CaptureDriver, [options as any]);
  return { driver, converter: driver.Container.resolve<DatetimeValueConverter>(DatetimeValueConverter) };
}

describe('mysql datetimes in the connection time zone', function () {
  this.timeout(15000);

  afterEach(() => {
    DI.clearCache();
  });

  it('writes the wall clock of a fixed offset zone and reads it back as the same instant', async () => {
    const { converter } = await converterOf('+02:00');

    expect(converter.toDB(AT, null as any, null as any)).to.eq('2026-10-01 00:00:00.000');
    expect((converter.fromDB('2026-10-01 00:00:00.000') as DateTime).toMillis()).to.eq(AT.getTime());
  });

  it('writes and reads the UTC wall clock in a UTC connection', async () => {
    const { converter } = await converterOf('UTC');

    expect(converter.toDB(AT, null as any, null as any)).to.eq('2026-09-30 22:00:00.000');
    expect((converter.fromDB('2026-09-30 22:00:00.000') as DateTime).toMillis()).to.eq(AT.getTime());
  });

  it('writes the process wall clock by default', async () => {
    const { converter } = await converterOf();

    expect(converter.toDB(AT, null as any, null as any)).to.eq(DateTime.fromJSDate(AT).toFormat('yyyy-MM-dd HH:mm:ss.SSS'));
    expect((converter.fromDB(DateTime.fromJSDate(AT).toFormat('yyyy-MM-dd HH:mm:ss')) as DateTime).toMillis()).to.eq(AT.getTime());
  });

  it('keeps the instant of a Date mysql2 parsed and of text with an offset', async () => {
    const { converter } = await converterOf('+02:00');

    expect((converter.fromDB(AT) as DateTime).toMillis()).to.eq(AT.getTime());
    expect((converter.fromDB('2026-09-30T22:00:00Z') as DateTime).toMillis()).to.eq(AT.getTime());
  });

  it('binds a raw statement Date in the connection zone', async () => {
    const { driver } = await converterOf('+02:00');

    await driver.executeOnDb('SELECT ?', [AT], QueryContext.Select);

    expect(driver.bound).to.deep.eq(['2026-10-01 00:00:00.000']);
  });
});
