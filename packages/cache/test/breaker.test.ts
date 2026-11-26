import { expect } from 'chai';
import 'mocha';
import { Breaker } from '../src/index.js';

describe('Breaker', () => {
  let now = 0;
  const make = (): Breaker => new Breaker(3, 1000, () => now);

  beforeEach(() => {
    now = 0;
  });

  it('opens after the given failures in a row; a success starts the count again', () => {
    const breaker = make();
    breaker.failed();
    breaker.failed();
    breaker.succeeded();
    breaker.failed();
    breaker.failed();
    expect(breaker.allows()).to.eq(true);
    expect(breaker.failed()).to.eq(true);
    expect(breaker.allows()).to.eq(false);
  });

  it('lets one call through once the reset time has passed, and closes when it succeeds', () => {
    const breaker = make();
    for (let i = 0; i < 3; i += 1) breaker.failed();
    now = 999;
    expect(breaker.allows()).to.eq(false);
    now = 1000;
    expect(breaker.allows()).to.eq(true);
    expect(breaker.allows()).to.eq(false);
    breaker.succeeded();
    expect(breaker.allows()).to.eq(true);
    expect(breaker.open).to.eq(false);
  });

  it('stays open another period when the trial call fails, and reports the opening once', () => {
    const breaker = make();
    breaker.failed();
    breaker.failed();
    expect(breaker.failed()).to.eq(true);
    now = 1000;
    expect(breaker.allows()).to.eq(true);
    expect(breaker.failed()).to.eq(false);
    now = 1999;
    expect(breaker.allows()).to.eq(false);
    now = 2000;
    expect(breaker.allows()).to.eq(true);
  });
});
