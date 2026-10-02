import assert from 'node:assert/strict';
import 'mocha';
import { FakeClock } from '../../src/fakes/index.js';

describe('FakeClock', () => {
  let clock: FakeClock;
  afterEach(() => clock?.uninstall());

  it('starts at a whole second by default and returns fresh dates', () => {
    clock = new FakeClock();
    assert.equal(clock.now().getTime() % 1000, 0);
    assert.notEqual(clock.now(), clock.now());
  });

  it('tick and set move now without touching Date until installed', () => {
    clock = new FakeClock(new Date('2030-01-01T00:00:00Z'));
    clock.tick(5000);
    assert.equal(clock.now().toISOString(), '2030-01-01T00:00:05.000Z');
    assert.notEqual(new Date().getUTCFullYear(), 2030);
    clock.set(new Date('2029-06-01T00:00:00Z'));
    assert.equal(clock.now().toISOString(), '2029-06-01T00:00:00.000Z');
    assert.throws(() => clock.tick(-1), RangeError);
  });

  it('install fakes Date only and follows tick and set', async () => {
    clock = new FakeClock(new Date('2030-01-01T00:00:00Z'));
    const hr = process.hrtime.bigint();
    clock.install();
    assert.equal(clock.installed, true);
    assert.equal(Date.now(), new Date('2030-01-01T00:00:00Z').getTime());
    assert.equal(new Date().toISOString(), '2030-01-01T00:00:00.000Z');
    clock.tick(1500);
    assert.equal(Date.now(), new Date('2030-01-01T00:00:01.500Z').getTime());
    clock.set(new Date('2020-01-01T00:00:00Z'));
    assert.equal(Date.now(), new Date('2020-01-01T00:00:00Z').getTime());
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.ok(process.hrtime.bigint() > hr);
    assert.ok(performance.now() > 0);
  });

  it('uninstall restores Date and is idempotent', () => {
    clock = new FakeClock(new Date('2030-01-01T00:00:00Z'));
    clock.install();
    clock.install();
    clock.uninstall();
    clock.uninstall();
    assert.equal(clock.installed, false);
    assert.notEqual(new Date().getUTCFullYear(), 2030);
  });

  it('ctx fills defaults and takes overrides', () => {
    clock = new FakeClock(new Date('2030-01-01T00:00:00Z'));
    assert.deepEqual(clock.ctx(), { now: new Date('2030-01-01T00:00:00Z'), ip: '192.0.2.10', userAgent: 'authn-testing', purpose: 'login' });
    assert.equal(clock.ctx({ ip: '192.0.2.20', purpose: 'reauth' }).ip, '192.0.2.20');
  });
});
