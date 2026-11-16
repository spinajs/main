import 'mocha';
import { expect } from 'chai';
import { dateCodec, type FormatTypes } from '../../src/runtime/index.js';

describe('dateCodec', () => {
  it('decodes ISO text with an offset to the exact instant', () => {
    const date = dateCodec.decode('2026-05-01T10:00:00+02:00');
    expect(date).to.be.instanceOf(Date);
    expect(date.toISOString()).to.equal('2026-05-01T08:00:00.000Z');
  });

  it('encodes a Date as toISOString()', () => {
    expect(dateCodec.encode(new Date('2026-05-01T08:00:00Z'))).to.equal('2026-05-01T08:00:00.000Z');
  });

  it('round-trips a Date', () => {
    const date = new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 6));
    expect(dateCodec.decode(dateCodec.encode(date)).getTime()).to.equal(date.getTime());
  });

  it('rejects text that is not a date, and a value that is not text', () => {
    expect(() => dateCodec.decode('yesterday')).to.throw(TypeError, /yesterday/);
    expect(() => dateCodec.decode(42)).to.throw(TypeError);
  });

  it('rejects an invalid Date on encode', () => {
    expect(() => dateCodec.encode(new Date('nope'))).to.throw(TypeError);
  });

  it('leaves a value that is not a Date to the server on encode', () => {
    expect(dateCodec.encode('2026-05-01T08:00:00Z' as unknown as Date)).to.equal('2026-05-01T08:00:00Z');
  });

  it('types each format slot as its codec value, else as wire text', () => {
    const types: FormatTypes<{ 'date-time': typeof dateCodec }> = { 'date-time': new Date(0), date: '2026-05-01', decimal: '1.5', int64: '9' };
    expect(types['date-time']).to.be.instanceOf(Date);
  });
});
