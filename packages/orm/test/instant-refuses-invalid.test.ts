import { expect } from 'chai';
import 'mocha';
import { InvalidArgument } from '@spinajs/exceptions';
import { DateTime } from 'luxon';

import { toInstant } from '../src/converters.js';
import type { DateTimeUnit } from '../src/converters.js';

const UNITS: DateTimeUnit[] = ['seconds', 'milliseconds'];

const NOT_AN_INSTANT: Array<[string, () => unknown]> = [
  ['DateTime.invalid', () => DateTime.invalid('test')],
  ['DateTime.fromMillis(NaN)', () => DateTime.fromMillis(NaN)],
  ['Invalid Date', () => new Date(NaN)],
  ['NaN', () => NaN],
  ['Infinity', () => Infinity],
  ['-Infinity', () => -Infinity],
  ['a number beyond the DateTime range', () => 1e20],
];

describe('toInstant refuses a present value that is not a valid instant', () => {
  for (const unit of UNITS) {
    for (const [label, make] of NOT_AN_INSTANT) {
      it(`${label} under unit ${unit} throws InvalidArgument naming the column`, () => {
        expect(() => toInstant(make(), 'ExpiresAt', unit)).to.throw(InvalidArgument, /^column ExpiresAt: /);
      });
    }

    it(`without a column name under unit ${unit} the error names the parameter`, () => {
      expect(() => toInstant(DateTime.invalid('test'), undefined, unit)).to.throw(InvalidArgument, /^parameter: /);
    });

    it(`null, undefined and '' under unit ${unit} stay null`, () => {
      for (const value of [null, undefined, '']) {
        expect(toInstant(value, 'ExpiresAt', unit), String(value)).to.eq(null);
      }
    });

    it(`a valid DateTime, Date, 0 and a negative number under unit ${unit} are read as before`, () => {
      const at = Date.UTC(2026, 11, 1, 10, 0, 0, 0);
      expect(toInstant(DateTime.fromMillis(at), 'ExpiresAt', unit)!.toMillis()).to.eq(at);
      expect(toInstant(new Date(at), 'ExpiresAt', unit)!.toMillis()).to.eq(at);
      expect(toInstant(0, 'ExpiresAt', unit)!.toMillis()).to.eq(0);
      expect(toInstant(-1000, 'ExpiresAt', unit)!.toMillis()).to.eq(unit === 'seconds' ? -1000000 : -1000);
    });
  }
});
