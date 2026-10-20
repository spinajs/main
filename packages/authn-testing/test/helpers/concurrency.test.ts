import assert from 'node:assert/strict';
import 'mocha';
import { burst } from '../../src/helpers/index.js';

describe('burst', () => {
  it('starts every call before any settles', async () => {
    const log: string[] = [];
    const r = await burst(5, async (i) => {
      log.push(`start${i}`);
      await Promise.resolve();
      log.push(`end${i}`);
      return i;
    });
    assert.deepEqual(log.slice(0, 5), ['start0', 'start1', 'start2', 'start3', 'start4']);
    assert.deepEqual(r.fulfilled(), [0, 1, 2, 3, 4]);
  });

  it('records rejections, including synchronous throws', async () => {
    const r = await burst(4, (i): Promise<number> => {
      if (i === 1) throw new Error('sync');
      return i === 2 ? Promise.reject(new Error('async')) : Promise.resolve(i);
    });
    assert.equal(r.outcomes.length, 4);
    assert.deepEqual(r.fulfilled(), [0, 3]);
    assert.deepEqual(
      r.rejected().map((e) => (e as Error).message),
      ['sync', 'async'],
    );
    assert.equal(
      r.count((v) => v > 0),
      1,
    );
  });
});
