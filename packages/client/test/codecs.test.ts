import 'mocha';
import { expect } from 'chai';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Big } from 'big.js';
import { Decimal } from 'decimal.js';
import { DateTime } from 'luxon';
import { bigintCodec, decimalCodec, luxonCodec, luxonDateCodec } from '../src/codecs/index.js';
import { type FormatTypes } from '../src/runtime/index.js';

// The server's `decimal` format (packages/validation/src/formats.ts).
const SERVER_DECIMAL = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

describe('luxonCodec', () => {
  const codec = luxonCodec(DateTime);

  it('decodes ISO text to a DateTime that keeps the offset', () => {
    const value = codec.decode('2026-05-01T10:00:00+02:00');
    expect(DateTime.isDateTime(value)).to.equal(true);
    expect(value.offset).to.equal(120);
    expect(value.toUTC().toISO()).to.equal('2026-05-01T08:00:00.000Z');
  });

  it('round-trips the instant and the offset', () => {
    const wire = '2026-05-01T10:00:00.123+02:00';
    expect(codec.encode(codec.decode(wire))).to.equal(wire);
    expect(codec.encode(codec.decode('2026-05-01T08:00:00.000Z'))).to.equal('2026-05-01T08:00:00.000Z');
  });

  it('rejects text that is not ISO, and a value that is not text', () => {
    expect(() => codec.decode('yesterday')).to.throw(TypeError, /yesterday/);
    expect(() => codec.decode(42)).to.throw(TypeError);
  });

  it('rejects an invalid DateTime on encode and leaves other values to the server', () => {
    expect(() => codec.encode(DateTime.invalid('test'))).to.throw(TypeError);
    expect(codec.encode('2026-05-01T08:00:00Z' as unknown as ReturnType<typeof codec.decode>)).to.equal('2026-05-01T08:00:00Z');
  });

  it('types the date-time slot as a luxon DateTime', () => {
    const types: FormatTypes<{ 'date-time': typeof codec }> = { 'date-time': codec.decode('2026-05-01T08:00:00Z'), date: '2026-05-01', decimal: '1', int64: '1' };
    expect(types['date-time'].year).to.equal(2026);
  });
});

describe('luxonDateCodec', () => {
  const codec = luxonDateCodec(DateTime);

  it('round-trips a calendar date', () => {
    const value = codec.decode('2026-05-01');
    expect(value.day).to.equal(1);
    expect(codec.encode(value)).to.equal('2026-05-01');
  });

  it('rejects text that is not a date, and date-time text that would lose its time', () => {
    expect(() => codec.decode('2026-13-45')).to.throw(TypeError);
    expect(() => codec.decode('2026-05-01T23:30:00+05:00')).to.throw(TypeError);
  });

  it('rejects an invalid DateTime on encode', () => {
    expect(() => codec.encode(DateTime.invalid('test'))).to.throw(TypeError);
  });
});

function makeSpecial<D>(Ctor: new (value: string) => D, text: string): D | undefined {
  try {
    return new Ctor(text);
  } catch {
    return undefined; // big.js cannot hold NaN or Infinity
  }
}

function describeDecimal<D extends { toFixed(): string; eq(other: D): boolean }>(name: string, Ctor: new (value: string) => D): void {
  describe(`decimalCodec with ${name}`, () => {
    const codec = decimalCodec(Ctor);

    it('decodes decimal text to the library type', () => {
      expect(codec.decode('12.50')).to.be.instanceOf(Ctor);
      expect(codec.decode('12.50').toFixed()).to.equal('12.5');
    });

    it('encodes in plain notation where toJSON() switches to exponent notation', () => {
      for (const text of ['1000000000000000000000', '0.0000001', '-123456789012345678901234567890.5', '0.00000000000000000001234']) {
        const wire = codec.encode(codec.decode(text));
        expect(wire, text).to.match(SERVER_DECIMAL);
        expect(new Ctor(wire as string).eq(new Ctor(text))).to.equal(true);
      }
      const json = JSON.parse(JSON.stringify(new Ctor('1e21'))) as string;
      expect(json).to.match(/e\+?21/);
      expect(SERVER_DECIMAL.test(json)).to.equal(false);
    });

    it('rejects text that is not a number, and a value that is not text', () => {
      expect(() => codec.decode('abc')).to.throw(TypeError, /abc/);
      expect(() => codec.decode(1.5)).to.throw(TypeError);
    });

    it('refuses NaN, Infinity and hex text on decode, and a NaN or Infinity value on encode', () => {
      for (const text of ['NaN', 'Infinity', '-Infinity', '0x1f', ' 12 ', '']) expect(() => codec.decode(text), text).to.throw(TypeError);
      for (const text of ['NaN', 'Infinity']) {
        const value = makeSpecial(Ctor, text);
        if (value) expect(() => codec.encode(value)).to.throw(TypeError);
      }
    });

    it('encodes a value of a cloned constructor or another copy of the library', () => {
      const other = { constructor: function Other() {}, toFixed: () => '1000000000000000000000' };
      expect(codec.encode(other as unknown as D)).to.equal('1000000000000000000000');
      expect(codec.encode(5 as unknown as D)).to.equal(5);
    });

    it('leaves a value that is not of the library type to the server', () => {
      expect(codec.encode('12.5' as unknown as D)).to.equal('12.5');
    });
  });
}

describeDecimal('decimal.js', Decimal);
describeDecimal('big.js', Big);

describe('bigintCodec', () => {
  it('round-trips a value beyond Number.MAX_SAFE_INTEGER', () => {
    const value = bigintCodec.decode('9007199254740993');
    expect(value).to.equal(9007199254740993n);
    expect(bigintCodec.encode(value)).to.equal('9007199254740993');
    expect(bigintCodec.decode('-5')).to.equal(-5n);
  });

  it('rejects text that is not an integer', () => {
    expect(() => bigintCodec.decode('1.5')).to.throw(TypeError);
    expect(() => bigintCodec.decode(5)).to.throw(TypeError);
  });

  it('sends a value that is not a bigint to the server as it is', () => {
    expect(bigintCodec.encode(5 as unknown as bigint)).to.equal(5);
  });
});

describe('@spinajs/client/codecs imports', () => {
  const dir = fileURLToPath(new URL('../src/codecs/', import.meta.url));
  const IMPORT = /^\s*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm;

  it('imports only types from the runtime, so no package is a runtime dependency', () => {
    const found: string[] = [];
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
      for (const match of readFileSync(dir + file, 'utf8').matchAll(IMPORT)) {
        if (!/^\s*import type\b/.test(match[0]) || match[1] !== '../runtime/index.js') found.push(`${file}: ${match[0].trim()}`);
      }
    }
    expect(found).to.deep.equal([]);
  });
});
