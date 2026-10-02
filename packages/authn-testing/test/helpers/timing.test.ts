import assert from 'node:assert/strict';
import 'mocha';
import { assertSameTiming, compareTiming, repeat, timingDefaults, timingTimeoutMs } from '../../src/helpers/index.js';
import type { TimedSource } from '../../src/helpers/index.js';

const spin = (ms: number) => async () => {
  const end = process.hrtime.bigint() + BigInt(Math.round(ms * 1e6));
  while (process.hrtime.bigint() < end) {
    // busy wait: timers would add CI jitter
  }
};

describe('timing helpers', () => {
  const quick = { runs: 20, warmup: 2, noiseFloorMs: 0.1, retries: 0 };

  it('passes for two equal busy-waits', async () => {
    const r = await compareTiming(repeat(spin(2)), repeat(spin(2)), quick);
    assert.equal(r.pass, true);
    assert.equal(r.attempts, 1);
  });

  it('fails for 2 ms against 4 ms', async () => {
    const r = await compareTiming(repeat(spin(2)), repeat(spin(4)), quick);
    assert.equal(r.pass, false);
    assert.ok(r.diffMs > 1.5);
    await assert.rejects(assertSameTiming(repeat(spin(2)), repeat(spin(4)), quick), assert.AssertionError);
  });

  it('prepares once per attempt with warmup + runs and retries on failure', async () => {
    const counts: number[] = [];
    const src = (ms: number): TimedSource => ({
      async prepare(count) {
        counts.push(count);
        return Array.from({ length: count }, () => spin(ms));
      },
    });
    const r = await compareTiming(src(1), src(3), { runs: 6, warmup: 2, noiseFloorMs: 0.1, retries: 2 });
    assert.equal(r.pass, false);
    assert.equal(r.attempts, 3);
    assert.deepEqual(counts, [8, 8, 8, 8, 8, 8]);
  });

  it('timingDefaults follows CI and env overrides', () => {
    assert.deepEqual(timingDefaults({}), { runs: 200, warmup: 20, tolerance: 0.1, noiseFloorMs: 0.5, retries: 2 });
    assert.deepEqual(timingDefaults({ CI: 'true' }), { runs: 200, warmup: 20, tolerance: 0.1, noiseFloorMs: 2, retries: 4 });
    const o = timingDefaults({ CI: '1', AUTHN_TESTING_TIMING_FLOOR_MS: '5', AUTHN_TESTING_TIMING_RETRIES: 'x' });
    assert.equal(o.noiseFloorMs, 5);
    assert.equal(o.retries, 4);
  });

  it('timingTimeoutMs has a 60 s floor and scales with the call cost', () => {
    const d = timingDefaults({});
    assert.equal(timingTimeoutMs(d, 0.1), 60000);
    assert.equal(timingTimeoutMs(d, 100), 3 * 2 * 220 * 100 * 1.5);
  });
});
