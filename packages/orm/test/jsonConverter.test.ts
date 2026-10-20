import 'mocha';
import { expect } from 'chai';
import { JsonValueConverter } from '../src/converters.js';

describe('JsonValueConverter', () => {
  const converter = new JsonValueConverter();

  it('writes null and undefined as they are, so the column holds SQL NULL', () => {
    expect(converter.toDB(null)).to.eq(null);
    expect(converter.toDB(undefined)).to.eq(undefined);
  });

  it('writes every other value as JSON text', () => {
    expect(converter.toDB({ a: [1, 'x'] })).to.eq('{"a":[1,"x"]}');
    expect(converter.toDB('gold')).to.eq('"gold"');
    expect(converter.toDB(false)).to.eq('false');
  });

  it('reads SQL NULL, a missing value and the JSON text null as null', () => {
    expect(converter.fromDB(null)).to.eq(null);
    expect(converter.fromDB(undefined)).to.eq(null);
    expect(converter.fromDB('null')).to.eq(null);
  });

  it('reads objects as they are and JSON text through JSON.parse', () => {
    const value = { a: 1 };
    expect(converter.fromDB(value)).to.eq(value);
    expect(converter.fromDB('{"a":[1,"x"]}')).to.deep.eq({ a: [1, 'x'] });
    expect(converter.fromDB('3.5')).to.eq(3.5);
  });
});
