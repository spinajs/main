import 'mocha';
import { expect } from 'chai';
import fc from 'fast-check';
import { createRequire } from 'node:module';
import { formatNames } from 'ajv-formats/dist/formats.js';
import { formatPredicate, isDate, isDateTime, isDecimal, isEmail, isHostname, isTime, isUrl, numberFormatPredicate } from '../../src/formats/index.js';
import { describeInput, serverAjv } from './server-ajv.js';

const COMMON = ['', ' ', 'a', '\n', 'null', '0', '\u0000', '😀', '\ud83d', '\ude00x', 'é'];

const STRING_CORPUS: Record<string, string[]> = {
  date: ['2020-01-01', '2020-02-29', '2019-02-29', '1900-02-29', '2000-02-29', '2021-04-31', '2021-04-30', '2021-02-30', '2021-13-01', '2021-00-10', '2021-01-00', '2021-1-01', '20210101', '2021-01-01T00:00:00Z', '0000-01-01', '9999-12-31', ' 2021-01-01', '2021-01-01\n', '２０２１-01-01'],
  time: ['00:00:00', '23:59:59', '23:59:60', '22:59:60', '23:58:60', '24:00:00', '23:60:00', '12:00:00Z', '12:00:00z', '12:00:00+01:00', '12:00:00+0100', '12:00:00+01', '12:00:00-23:59', '12:00:00+99:99', '12:00:00.123', '12:00:00.', '12:00:00.123456789Z', '12:00', '1:00:00', '12:00:00 Z', '12:00:00+1:00'],
  'date-time': ['2020-01-01T00:00:00Z', '2020-01-01t00:00:00z', '2020-01-01 00:00:00Z', '2020-01-01T00:00:00', '2020-01-01T23:59:60Z', '2020-02-30T00:00:00Z', '2020-02-29T00:00:00Z', '2020-01-01T00:00:00+01:00', '2020-01-01T00:00:00.5-05:00', '2020-01-01TT00:00:00Z', '2020-01-01T00:00:00Z ', '2020-01-01\t00:00:00Z', '2020-01-01\u00a000:00:00Z', '2020-01-01\u200000:00:00Z', '2020-01-01T00:00:00ZT', '2020-01-01'],
  duration: ['P1Y', 'P1Y2M3DT4H5M6S', 'PT1H', 'PT', 'P', 'P1W', 'P1Y1W', 'PT1.5S', 'P1D', 'PT36H', '-P1D', 'p1d'],
  uri: ['http://example.com', 'https://user:pw@example.com:8080/p?q=1#f', 'urn:isbn:0451450523', 'mailto:a@b.c', 'http://[::1]/', 'http://[v1.x]/', 'http://münchen.de', '//example.com', '/relative', 'relative', 'a:b', 'http://exa mple.com', 'HTTP://EXAMPLE.COM', 'http://%zz', 'http://ex%41.com', 'file:///c:/x', '1http://x', 'http://x/"y"'],
  'uri-reference': ['http://example.com', '#frag', '?q', '//example.com/a', '/a/b', 'a/b', 'http://x/"y"', '\\\\x', 'http://exa mple.com', 'http://[::1]/', '%zz', 'http://münchen.de'],
  'uri-template': ['http://example.com/{id}', '{+path}', '{?q,r}', '{x:3}', '{x*}', '{x:0}', '{', '}', '{a b}', 'http://ex.com/%7e', '%zz', 'a"b', 'a\u0001b', 'a\u0020b', 'a\u007fb', '{x:10000}'],
  url: ['http://example.com', 'https://example.com:8080/path', 'ftp://x.y.com', 'http://10.0.0.1', 'http://192.168.0.1', 'http://172.16.0.1', 'http://8.8.8.8', 'http://223.255.255.254', 'http://224.0.0.1', 'http://münchen.de', 'http://例え.テスト', 'http://xn--mnchen-3ya.de', 'http://localhost', 'http://a.b', 'http://a.bc', 'http://user@host.com', 'mailto:x@y.z', 'http://example.com/😀', 'http://😀.com', 'HTTP://EXAMPLE.COM', 'http://example.com:1'],
  email: ['a@b.co', 'A@B.CO', 'a.b@c.d', 'a..b@c.d', '.a@b.c', 'a@b', 'a@-b.c', 'a@b-.c', 'a@münchen.de', 'ü@b.c', '"a"@b.c', 'a+b@c.d', 'a@b.c.', 'a@[127.0.0.1]', 'a@b_c.d', 'a@xn--mnchen-3ya.de'],
  hostname: ['example.com', 'example.com.', 'a', '-a.com', 'a-.com', `${'a'.repeat(63)}.com`, `${'a'.repeat(64)}.com`, `${'a.'.repeat(126)}a`, `${'a.'.repeat(126)}ab`, 'münchen.de', 'xn--mnchen-3ya.de', 'a..b', '_a.com', '1.2.3.4', 'a.b-c.d'],
  ipv4: ['0.0.0.0', '255.255.255.255', '256.0.0.1', '01.02.03.04', '001.2.3.4', '1.2.3', '1.2.3.4.5', ' 1.2.3.4', '1.2.3.04', '١.٢.٣.٤'],
  ipv6: ['::', '::1', '1::', '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8:9', '::ffff:1.2.3.4', '1::2::3', 'FE80::1', 'fe80::1%eth0', '1:2:3:4:5:6:1.2.3.4', '12345::1', '::ffff:256.1.1.1'],
  regex: ['^a$', '[', '(?<n>a)', 'a\\Z', '\\Z', 'a\\\\Z', '(?<=a)b', '\\p{L}', '\\u{1F600}', '[a-z]{2,}', '*', 'a{2,1}', '(?i)a'],
  uuid: ['123e4567-e89b-12d3-a456-426614174000', '123E4567-E89B-12D3-A456-426614174000', 'urn:uuid:123e4567-e89b-12d3-a456-426614174000', '123e4567e89b12d3a456426614174000', '123e4567-e89b-12d3-a456-42661417400', '{123e4567-e89b-12d3-a456-426614174000}', 'zzze4567-e89b-12d3-a456-426614174000'],
  'json-pointer': ['/', '/a', '/a~0b', '/a~1b', '/a~2b', '/a/b', '~', '/~', '/a b'],
  'json-pointer-uri-fragment': ['#', '#/', '#/a', '#/a%20b', '#/a b', '#/a~1', '#/%zz', '/a', '#a'],
  'relative-json-pointer': ['1', '01', '0#', '1/a', '0/a~1b', '-1', '1#/', '10/a', '0/~2'],
  byte: ['QUJD', 'QUI=', 'QQ==', 'QQ=', 'QUJ', 'Q', '!!!!', 'QUJD\nQUJD', '!!!!\nQUJD', 'QUJD\n!!!!', 'QUJD==', 'QUJD\r\n'],
  password: ['secret'],
  binary: ['\u0000\u00ff'],
};

const NUMBER_CORPUS: number[] = [0, -0, 1, -1, 1.5, 2 ** 31 - 1, 2 ** 31, -(2 ** 31), -(2 ** 31) - 1, 2 ** 53, 2 ** 53 + 2, 1e308, Number.MAX_VALUE, Number.MIN_VALUE, Number.EPSILON, NaN, Infinity, -Infinity];

function alphabetOf(corpus: string[]): string[] {
  return [...new Set([...COMMON, ...corpus].flatMap((s) => [...s]))];
}

function mutated(corpus: string[], alphabet: string[]): fc.Arbitrary<string> {
  const edit = fc.tuple(fc.nat(), fc.constantFrom(...alphabet), fc.constantFrom('insert', 'replace', 'delete'));
  return fc.tuple(fc.constantFrom(...corpus), fc.array(edit, { minLength: 1, maxLength: 3 })).map(([seed, edits]) =>
    edits.reduce((s, [at, char, kind]) => {
      const units = [...s];
      const i = units.length === 0 ? 0 : at % (units.length + (kind === 'insert' ? 1 : 0));
      units.splice(i, kind === 'insert' ? 0 : 1, ...(kind === 'delete' ? [] : [char]));
      return units.join('');
    }, seed),
  );
}

function stringsFor(corpus: string[]): fc.Arbitrary<string> {
  const alphabet = alphabetOf(corpus);
  return fc.oneof(fc.string({ unit: 'binary', maxLength: 30 }), fc.string({ unit: fc.constantFrom(...alphabet), maxLength: 40 }), mutated(corpus, alphabet));
}

describe('@spinajs/client/formats: format predicates', () => {
  const ajv = serverAjv(false);

  it('test against the ajv-formats the server installs', () => {
    const fromServer = createRequire(new URL('../../../validation/package.json', import.meta.url));
    const fromClient = createRequire(new URL('../../package.json', import.meta.url));
    expect(fromClient.resolve('ajv-formats')).to.equal(fromServer.resolve('ajv-formats'));
    expect(fromClient.resolve('ajv')).to.equal(fromServer.resolve('ajv'));
  });

  it('cover every format ajv-formats registers, with nothing extra but decimal', () => {
    const known = (name: string): boolean => formatPredicate(name) !== undefined || numberFormatPredicate(name) !== undefined;
    expect(formatNames.filter((name) => !known(name))).to.deep.equal([]);
    expect(Object.keys(STRING_CORPUS).length + 4).to.equal(formatNames.length);
    expect(known('decimal')).to.be.true;
    for (const name of ['nope', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(known(name), name).to.be.false;
    }
  });

  it('keep string and number formats apart, as ajv-formats types them', () => {
    for (const name of ['int32', 'int64', 'float', 'double']) {
      expect(formatPredicate(name), name).to.equal(undefined);
    }
    for (const name of Object.keys(STRING_CORPUS)) {
      expect(numberFormatPredicate(name), name).to.equal(undefined);
    }
  });

  for (const [name, corpus] of Object.entries(STRING_CORPUS)) {
    it(`${name}: answers as Ajv on the corpus and on generated strings`, () => {
      const check = ajv.compile({ format: name });
      const predicate = formatPredicate(name)!;
      for (const input of [...COMMON, ...corpus]) {
        expect(predicate(input), describeInput(input)).to.equal(check(input));
      }
      fc.assert(
        fc.property(stringsFor(corpus), (input) => predicate(input) === check(input)),
        { numRuns: 2000 },
      );
    });
  }

  for (const name of ['int32', 'int64', 'float', 'double']) {
    it(`${name}: answers as Ajv on numbers`, () => {
      const check = ajv.compile({ format: name });
      const predicate = numberFormatPredicate(name)!;
      for (const input of NUMBER_CORPUS.filter(Number.isFinite)) {
        expect(predicate(input), describeInput(input)).to.equal(check(input));
      }
      for (const input of [NaN, Infinity, -Infinity]) {
        expect(check(input), `Ajv skips the format for ${input}`).to.be.true;
      }
      const numbers = fc.oneof(fc.double({ noNaN: true, noDefaultInfinity: true }), fc.integer({ min: -(2 ** 31) - 4, max: 2 ** 31 + 4 }), fc.integer().map((n) => n * 2 ** 22));
      fc.assert(
        fc.property(numbers, (input) => predicate(input) === check(input)),
        { numRuns: 2000 },
      );
    });
  }

  describe('the server rules zod would get wrong', () => {
    it('date: real calendar days and leap years', () => {
      expect(isDate('2020-02-29')).to.be.true;
      expect(isDate('2000-02-29')).to.be.true;
      expect(isDate('1900-02-29')).to.be.false;
      expect(isDate('2021-04-31')).to.be.false;
    });

    it('time: the leap second only at 23:59:60, offsets with and without a colon', () => {
      expect(isTime('23:59:60')).to.be.true;
      expect(isTime('22:59:60')).to.be.false;
      expect(isTime('12:00:00+0100')).to.be.true;
      expect(isTime('12:00:00+01')).to.be.true;
      expect(isTime('12:00:00')).to.be.true;
    });

    it('date-time: t or any whitespace separator, and ajv-formats 2.1.1 lets a missing zone through', () => {
      expect(isDateTime('2020-01-01t00:00:00z')).to.be.true;
      expect(isDateTime('2020-01-01 00:00:00Z')).to.be.true;
      expect(isDateTime('2020-01-01\u00a000:00:00Z')).to.be.true;
      expect(isDateTime('2020-01-01T23:59:60Z')).to.be.true;
      expect(isDateTime('2020-01-01T00:00:00')).to.be.true;
    });

    it('IDN: url accepts it, hostname and email do not', () => {
      expect(isUrl('http://münchen.de')).to.be.true;
      expect(isHostname('münchen.de')).to.be.false;
      expect(isEmail('a@münchen.de')).to.be.false;
    });

    it('decimal: the regex the server registers for the decimal format', () => {
      for (const valid of ['0', '-0', '12', '-12.50', '0.001']) {
        expect(isDecimal(valid), valid).to.be.true;
      }
      for (const invalid of ['', '01', '1.', '.5', '+1', '1e3', '1,5', ' 1', '١']) {
        expect(isDecimal(invalid), invalid).to.be.false;
      }
    });
  });
});
