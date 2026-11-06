import { expect } from 'chai';
import { InvalidArgument } from '@spinajs/exceptions';
import { parseDuration } from '../src/index.js';

describe('parseDuration', () => {
  it('parses unit suffixes', () => {
    expect(parseDuration('500ms')).to.eq(500);
    expect(parseDuration('10s')).to.eq(10_000);
    expect(parseDuration('5m')).to.eq(300_000);
    expect(parseDuration('2h')).to.eq(7_200_000);
    expect(parseDuration('30d')).to.eq(2_592_000_000);
    expect(parseDuration('1w')).to.eq(604_800_000);
    expect(parseDuration('1.5s')).to.eq(1500);
    expect(parseDuration(' 3 M ')).to.eq(180_000);
  });

  it('passes numbers through as milliseconds', () => {
    expect(parseDuration(2500)).to.eq(2500);
  });

  it('rejects garbage and negatives with the field name', () => {
    expect(() => parseDuration('soon', 'jitter')).to.throw(InvalidArgument, /jitter/);
    expect(() => parseDuration(-1)).to.throw(InvalidArgument);
    expect(() => parseDuration(Number.NaN)).to.throw(InvalidArgument);
  });
});
