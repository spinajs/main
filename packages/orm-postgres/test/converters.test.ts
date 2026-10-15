import { expect } from 'chai';
import 'mocha';

import { PostgresJsonValueConverter } from '../src/converters.js';

describe('PostgresJsonValueConverter', () => {
  const c = new PostgresJsonValueConverter();

  it('passes through what node-postgres already parsed from json/jsonb', () => {
    expect(c.fromDB({ a: 1 })).to.deep.equal({ a: 1 });
    expect(c.fromDB([1, 2])).to.deep.equal([1, 2]);
    expect(c.fromDB(5)).to.equal(5);
    expect(c.fromDB(true)).to.equal(true);
    expect(c.fromDB(null)).to.equal(null);
  });

  it('reads a JSON string value as that string', () => {
    expect(c.fromDB('plain')).to.equal('plain');
  });

  it('still parses JSON text from a TEXT column', () => {
    expect(c.fromDB('{"a":1}')).to.deep.equal({ a: 1 });
  });
});
