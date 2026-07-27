import { expect } from 'chai';
import { DateTime } from 'luxon';
import { InvalidArgument } from '@spinajs/exceptions';
import {
  _check_arg,
  _try_check_arg,
  _to_upper,
  _to_lower,
  _trim,
  _between,
  _min_length,
  _max_length,
  _min,
  _max,
  _lt,
  _lte,
  _gt,
  _gte,
  _non_null,
  _non_undefined,
  _non_NaN,
  _non_nil,
  _non_empty,
  _contains,
  _one_of,
  _reg_match,
  _glob_match,
  _is_email,
  _is_uuid,
  _to_int,
  _to_float,
  _to_date,
  _positive,
  _convert,
  _or,
  _is_instance_of,
  _contains_key,
} from '../src/index.js';

const run = (check: (a: any, n: string) => any, val: any, name = 'v') => _check_arg(check)(val, name);

describe('args validators (extended)', () => {
  describe('transforms', () => {
    it('_to_upper / _to_lower only affect strings', () => {
      expect(run(_to_upper(), 'abc')).to.eq('ABC');
      expect(run(_to_lower(), 'ABC')).to.eq('abc');
      expect(run(_to_upper(), 5)).to.eq(5);
    });

    it('_trim trims whitespace or a given char', () => {
      expect(run(_trim(), '  x  ')).to.eq('x');
      expect(run(_trim('_'), '__x__')).to.eq('x');
      expect(run(_trim(), 5)).to.eq(5);
    });

    it('_convert maps the value, wrapping thrown errors', () => {
      expect(run(_convert((s: string) => s.length), 'abcd')).to.eq(4);
      expect(() =>
        run(
          _convert(() => {
            throw new Error('x');
          }),
          'a',
        ),
      ).to.throw(InvalidArgument, /failed conversion/);
    });
  });

  describe('range & comparison', () => {
    it('_between on length and number', () => {
      expect(run(_between(1, 3), 'ab')).to.eq('ab');
      expect(run(_between(1, 3), 2)).to.eq(2);
      expect(() => run(_between(1, 3), 'abcd')).to.throw(InvalidArgument);
      expect(() => run(_between(1, 3), 5)).to.throw(InvalidArgument);
    });

    it('_min_length / _max_length on strings and arrays', () => {
      expect(run(_min_length(2), 'ab')).to.eq('ab');
      expect(run(_max_length(2), [1, 2])).to.deep.eq([1, 2]);
      expect(() => run(_min_length(3), 'ab')).to.throw(InvalidArgument);
      expect(() => run(_max_length(1), [1, 2])).to.throw(InvalidArgument);
      expect(() => run(_min_length(1), 5)).to.throw(InvalidArgument, /string or an array/);
    });

    it('_min / _max', () => {
      expect(run(_min(5), 5)).to.eq(5);
      expect(run(_max(5), 5)).to.eq(5);
      expect(() => run(_min(5), 4)).to.throw(InvalidArgument);
      expect(() => run(_max(5), 6)).to.throw(InvalidArgument);
    });

    it('_lt / _lte / _gt / _gte pass through non-numbers', () => {
      expect(run(_lt(5), 4)).to.eq(4);
      expect(run(_lte(5), 5)).to.eq(5);
      expect(run(_gt(5), 6)).to.eq(6);
      expect(run(_gte(5), 5)).to.eq(5);
      expect(run(_lt(5), 'skip')).to.eq('skip');
      expect(() => run(_lt(5), 5)).to.throw(InvalidArgument);
      expect(() => run(_gt(5), 5)).to.throw(InvalidArgument);
    });

    it('_positive requires > 0', () => {
      expect(run(_positive(), 1)).to.eq(1);
      expect(() => run(_positive(), 0)).to.throw(InvalidArgument);
      expect(() => run(_positive(), -1)).to.throw(InvalidArgument);
    });
  });

  describe('presence', () => {
    it('_non_null / _non_undefined', () => {
      expect(run(_non_null(), 0)).to.eq(0);
      expect(run(_non_undefined(), null)).to.eq(null);
      expect(() => run(_non_null(), null)).to.throw(InvalidArgument);
      expect(() => run(_non_undefined(), undefined)).to.throw(InvalidArgument);
    });

    it('_non_NaN', () => {
      expect(run(_non_NaN(), 5)).to.eq(5);
      expect(() => run(_non_NaN(), NaN)).to.throw(InvalidArgument);
    });

    it('_non_nil rejects null/undefined/empty', () => {
      expect(run(_non_nil(), 'x')).to.eq('x');
      expect(() => run(_non_nil(), '')).to.throw(InvalidArgument);
      expect(() => run(_non_nil(), [])).to.throw(InvalidArgument);
      expect(() => run(_non_nil(), {})).to.throw(InvalidArgument);
    });

    it('_non_empty', () => {
      expect(run(_non_empty(), [1])).to.deep.eq([1]);
      expect(() => run(_non_empty(), '')).to.throw(InvalidArgument);
    });
  });

  describe('choice & pattern', () => {
    it('_contains / _one_of', () => {
      expect(run(_contains(['a', 'b']), 'a')).to.eq('a');
      expect(run(_one_of([1, 2, 3]), 2)).to.eq(2);
      expect(() => run(_contains(['a']), 'z')).to.throw(InvalidArgument);
    });

    it('_reg_match / _glob_match pass through non-strings', () => {
      expect(run(_reg_match(/^\d+$/), '123')).to.eq('123');
      expect(() => run(_reg_match(/^\d+$/), 'abc')).to.throw(InvalidArgument);
      expect(run(_glob_match('*.ts'), 'index.ts')).to.eq('index.ts');
      expect(() => run(_glob_match('*.ts'), 'index.js')).to.throw(InvalidArgument);
      expect(run(_reg_match(/x/), 5)).to.eq(5);
    });

    it('_is_email / _is_uuid', () => {
      expect(run(_is_email(), 'a@b.com')).to.eq('a@b.com');
      expect(() => run(_is_email(), 'nope')).to.throw(InvalidArgument);
      expect(run(_is_uuid(), '11111111-1111-4111-8111-111111111111')).to.match(/1111/);
      expect(() => run(_is_uuid(), 'not-a-uuid')).to.throw(InvalidArgument);
    });
  });

  describe('conversions', () => {
    it('_to_int / _to_float', () => {
      expect(run(_to_int(), '42')).to.eq(42);
      expect(run(_to_float(), '3.14')).to.eq(3.14);
      expect(() => run(_to_int(), 'abc')).to.throw(InvalidArgument);
      expect(() => run(_to_float(), 'abc')).to.throw(InvalidArgument);
    });

    it('_to_date parses ISO strings and Date objects', () => {
      const iso = run(_to_date(), '2026-07-13') as DateTime;
      expect(iso.isValid).to.be.true;
      expect(iso.year).to.eq(2026);
      const fromJs = run(_to_date(), new Date(2026, 0, 2)) as DateTime;
      expect(fromJs.isValid).to.be.true;
      expect(() => run(_to_date(), 'not-a-date')).to.throw(InvalidArgument);
      expect(() => run(_to_date(), 123)).to.throw(InvalidArgument);
    });
  });

  describe('combinators', () => {
    it('_or passes if any check passes', () => {
      const check = _or(_is_email(), _reg_match(/^\d+$/));
      expect(check('a@b.com', 'v')).to.eq('a@b.com');
      expect(check('123', 'v')).to.eq('123');
      expect(() => check('neither', 'v')).to.throw(InvalidArgument, /at least one/);
    });

    it('_is_instance_of checks constructor', () => {
      class Foo {}
      expect(run(_is_instance_of(Foo), new Foo())).to.be.instanceOf(Foo);
      expect(() => run(_is_instance_of(Foo), {})).to.throw(InvalidArgument);
    });

    it('_contains_key on Map and object', () => {
      expect(run(_contains_key('a'), new Map([['a', 1]]))).to.be.instanceOf(Map);
      expect(run(_contains_key('a'), { a: 1 })).to.deep.eq({ a: 1 });
      expect(() => run(_contains_key('z'), new Map([['a', 1]]))).to.throw(InvalidArgument);
    });

    it('_try_check_arg returns a tuple instead of throwing', () => {
      const check = _try_check_arg(_min(5));
      expect(check(6, 'v')).to.deep.eq([true, 6]);
      const [ok, err] = check(1, 'v');
      expect(ok).to.be.false;
      expect(err).to.be.instanceOf(InvalidArgument);
    });
  });
});
