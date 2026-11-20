import { expect } from 'chai';
import 'mocha';
import { DateTime } from 'luxon';
import { IColumnDescriptor } from '@spinajs/orm';

import { MySqlDatetimeValueConverter } from '../src/converters.js';

const AT = 1794612404654;
const col = (Type: string) => ({ Name: 'At', Type }) as IColumnDescriptor;

describe('MySqlDatetimeValueConverter on a numeric column', () => {
  const c = new MySqlDatetimeValueConverter('Europe/Warsaw');

  it('writes milliseconds when asked', () => {
    expect(c.toDB(DateTime.fromMillis(AT), undefined, col('bigint'), { unit: 'milliseconds' })).to.eq(AT);
  });

  it('reads a number and the decimal text mysql2 returns in the declared unit', () => {
    expect(c.fromDB(AT, undefined, { unit: 'milliseconds' })!.toMillis()).to.eq(AT);
    expect(c.fromDB(`${AT}.000`, undefined, { unit: 'milliseconds' })!.toMillis()).to.eq(AT);
    expect(c.fromDB(Math.floor(AT / 1000))!.toMillis()).to.eq(Math.floor(AT / 1000) * 1000);
  });

  it('still reads wall-clock text in the session zone', () => {
    expect(c.fromDB('2026-11-14 00:26:44.654')!.toMillis()).to.eq(AT);
  });
});
