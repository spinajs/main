import { expect } from 'chai';
import 'mocha';
import { DateTime } from 'luxon';
import { IColumnDescriptor } from '@spinajs/orm';

import { PostgresDatetimeValueConverter } from '../src/converters.js';

const AT = 1794612404654;
const col = (Type: string) => ({ Name: 'At', Type }) as IColumnDescriptor;

describe('PostgresDatetimeValueConverter on a numeric column', () => {
  const c = new PostgresDatetimeValueConverter();

  it('writes seconds by default and milliseconds when asked', () => {
    expect(c.toDB(DateTime.fromMillis(AT), undefined, col('int8'))).to.eq(Math.floor(AT / 1000));
    expect(c.toDB(DateTime.fromMillis(AT), undefined, col('int8'), { unit: 'milliseconds' })).to.eq(AT);
    expect(c.toDB(AT, undefined, col('int8'), { unit: 'milliseconds' })).to.eq(AT);
  });

  it('reads the int8 text node-postgres returns in the declared unit', () => {
    expect(c.fromDB(String(AT), undefined, { unit: 'milliseconds' })!.toMillis()).to.eq(AT);
    expect(c.fromDB(String(Math.floor(AT / 1000)))!.toMillis()).to.eq(Math.floor(AT / 1000) * 1000);
  });
});
