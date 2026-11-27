import 'mocha';
import assert from 'node:assert';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { DatetimeValueConverter, type IColumnDescriptor, type IDriverOptions } from '@spinajs/orm';
import { PostgresDatetimeValueConverter } from '@spinajs/orm-postgres';
import { DateTime } from 'luxon';

import { PgliteOrmDriver } from '../src/index.js';

describe('pglite datetime converter', () => {
  afterEach(() => {
    DI.clearCache();
  });

  it('is the postgres converter, which refuses an invalid instant naming the column', async () => {
    const options: Partial<IDriverOptions> = { Name: 'pglite-datetime', Driver: 'orm-driver-pglite' };
    const driver = await DI.resolve(PgliteOrmDriver, [options]);
    const converter = driver.Container.resolve(DatetimeValueConverter);
    const expiresAt = { Name: 'ExpiresAt', Type: 'timestamptz' } as IColumnDescriptor;

    assert(converter instanceof PostgresDatetimeValueConverter);
    for (const value of [DateTime.invalid('test'), new Date(NaN), NaN, Infinity, -Infinity]) {
      const write = () => {
        converter.toDB(value, undefined, expiresAt, { unit: 'seconds' });
      };
      expect(write, String(value)).to.throw(/^column ExpiresAt: .* is not a valid instant$/);
    }
  });
});
