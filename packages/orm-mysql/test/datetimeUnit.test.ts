import { expect } from 'chai';
import 'mocha';
import { DateTime } from 'luxon';
import { InvalidArgument } from '@spinajs/exceptions';
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

describe('MySqlDatetimeValueConverter and an invalid instant', () => {
  const c = new MySqlDatetimeValueConverter('UTC+02:00');
  const expiresAt = (Type: string) => ({ Name: 'ExpiresAt', Type }) as IColumnDescriptor;

  const notAnInstant: Array<[string, () => unknown]> = [
    ['DateTime.invalid', () => DateTime.invalid('test')],
    ['Invalid Date', () => new Date(NaN)],
    ['NaN', () => NaN],
    ['Infinity', () => Infinity],
    ['-Infinity', () => -Infinity],
  ];

  for (const [label, make] of notAnInstant) {
    it(`${label} throws naming the column for a DATETIME and a BIGINT column`, () => {
      expect(() => c.toDB(make(), undefined, expiresAt('datetime'), { unit: 'seconds' })).to.throw(InvalidArgument, /^column ExpiresAt: .* is not a valid instant$/);
      expect(() => c.toDB(make(), undefined, expiresAt('bigint'), { unit: 'milliseconds' })).to.throw(InvalidArgument, /^column ExpiresAt: .* is not a valid instant$/);
    });
  }

  it('null still writes NULL', () => {
    expect(c.toDB(null, undefined, expiresAt('datetime'), { unit: 'seconds' })).to.eq(null);
  });
});
