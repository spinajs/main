import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { expect } from 'chai';

import { _chain, _zip, _map, _all, _use, _catch, _catchFilter, _catchValue, _catchException, _fallback, _tap, _either, _to_array, _pipe, _filter, _reduce, _sequence, _race, _when, _unless, _finally, _tapError, _or_else, _concurrent, _batch } from '../src/index.js';

chai.use(chaiAsPromised);

describe('fp', () => {
  describe('sync throw handling', () => {
    it('_catch invokes handler on sync throw', async () => {
      const a = () => {
        throw new Error('sync');
      };

      const res = await _catch(a, async () => 'recovered')();
      expect(res).to.eq('recovered');
    });

    it('_catchFilter invokes handler on sync throw when filter matches', async () => {
      const a = () => {
        throw new Error('sync');
      };

      const res = await _catchFilter(
        a,
        () => 'handled',
        (err) => err.message === 'sync',
      )();
      expect(res).to.eq('handled');
    });

    it('_catchFilter rejects on sync throw when filter does not match', async () => {
      const a = () => {
        throw new Error('sync');
      };

      await expect(
        _catchFilter(
          a,
          () => 'handled',
          (err) => err.message === 'other',
        )(),
      ).to.be.rejectedWith('sync');
    });

    it('_catchValue invokes handler on sync thrown value', async () => {
      const a = () => {
        // eslint-disable-next-line no-throw-literal
        throw 'E_ERROR';
      };

      const res = await _catchValue(a, () => 'handled', 'E_ERROR')();
      expect(res).to.eq('handled');
    });

    it('_catchException invokes handler on sync thrown exception', async () => {
      class TestError extends Error {}
      const a = () => {
        throw new TestError('sync');
      };

      const res = await _catchException(a, () => 'handled', TestError)();
      expect(res).to.eq('handled');
    });

    it('_fallback returns fallback value on sync throw', async () => {
      const a = () => {
        throw new Error('sync');
      };

      const res = await _fallback(a, () => 'fallback')();
      expect(res).to.eq('fallback');
    });
  });

  describe('_tap', () => {
    it('supports sync side effect function', async () => {
      let called: unknown;
      const sideEffect = (v: unknown) => {
        called = v;
      };

      const res = await _chain(
        () => 'A',
        _tap(sideEffect),
      );
      expect(res).to.eq('A');
      expect(called).to.eq('A');
    });

    it('supports direct promise variant', async () => {
      const res = await _chain(
        () => 'A',
        _tap(Promise.resolve('B')),
      );
      expect(res).to.eq('A');
    });
  });

  describe('_either', () => {
    it('supports sync condition', async () => {
      const t = await _either(
        (a) => a === 1,
        async () => 'yes',
        async () => 'no',
      )(1);
      expect(t).to.eq('yes');

      const f = await _either(
        (a) => a === 1,
        async () => 'yes',
        async () => 'no',
      )(2);
      expect(f).to.eq('no');
    });

    it('without onRejected resolves null when async condition is false', async () => {
      const r = await _either(
        async (a) => !!a,
        async () => 'yes',
      )(0);
      expect(r).to.be.null;
    });
  });

  describe('_map', () => {
    it('throws descriptive error on non-array input', () => {
      expect(() => _map(async (v: number) => v)(undefined as any)).to.throw(/_map/);
    });
  });

  describe('_chain', () => {

    it('suppresses unhandled rejection of eager promise after earlier failure', async () => {
      const events: unknown[] = [];
      const listener = (reason: unknown) => {
        events.push(reason);
      };
      process.on('unhandledRejection', listener);

      try {
        const eager = Promise.reject(new Error('second'));
        await expect(_chain(() => Promise.reject(new Error('first')), eager)).to.be.rejectedWith('first');

        // let potential unhandled rejection events fire
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        expect(events).to.have.lengthOf(0);
      } finally {
        process.off('unhandledRejection', listener);
      }
    });
  });

  describe('_zip', () => {

    it('passes chained value to all functions', async () => {
      const res = await _chain(
        2,
        _zip(
          async (v: any) => v + 1,
          async (v: any) => v * 10,
        ),
      );
      expect(res).to.deep.eq([3, 20]);
    });
  });

  describe('_all', () => {
    it('resolves array of promises', async () => {
      const res = await _all()([Promise.resolve(1), Promise.resolve(2)]);
      expect(res).to.deep.eq([1, 2]);
    });

    it('passes through single promise', async () => {
      const res = await _all()(Promise.resolve(7));
      expect(res).to.eq(7);
    });
  });

  describe('_to_array', () => {
    it('wraps single value', () => {
      expect(_to_array()(5)).to.deep.eq([5]);
    });
  });

  describe('_use', () => {
    it('ignores non-object accumulator', async () => {
      const res = await _chain(
        () => 5,
        _use(() => Promise.resolve('x'), 'a'),
      );
      expect(res).to.deep.eq({ a: 'x' });
    });
  });

  describe('_pipe', () => {
    it('composes reusable pipeline, arg fed to first step', async () => {
      const pipeline = _pipe<number>(
        (v: number) => v + 1,
        (v: number) => Promise.resolve(v * 2),
      );

      expect(await pipeline(2)).to.eq(6);
      expect(await pipeline(5)).to.eq(12);
    });
  });

  describe('_filter', () => {
    it('filters with async predicate preserving order', async () => {
      const res = await _filter(async (v: number) => v % 2 === 0)([1, 2, 3, 4, 5, 6]);
      expect(res).to.deep.eq([2, 4, 6]);
    });

    it('throws descriptive error on non-array input', () => {
      expect(() => _filter((v: number) => v > 0)(undefined as any)).to.throw(/_filter/);
    });
  });

  describe('_reduce', () => {
    it('reduces with async reducer starting from initial', async () => {
      const res = await _reduce(async (acc: number, v: number) => acc + v, 10)([1, 2, 3]);
      expect(res).to.eq(16);
    });

    it('throws descriptive error on non-array input', () => {
      expect(() => _reduce((acc: number, v: number) => acc + v, 0)(undefined as any)).to.throw(/_reduce/);
    });
  });

  describe('_sequence', () => {

    it('throws descriptive error on non-array input', () => {
      expect(() => _sequence(async (v: number) => v)(undefined as any)).to.throw(/_sequence/);
    });
  });

  describe('_race', () => {
    it('resolves with first settled result', async () => {
      const slow = (v: number) => new Promise<string>((r) => setTimeout(() => r(`slow ${v}`), 50));
      const fast = (v: number) => new Promise<string>((r) => setTimeout(() => r(`fast ${v}`), 5));

      const res = await _race(slow, fast)(1);
      expect(res).to.eq('fast 1');
    });
  });

  describe('_when', () => {
    it('runs fn when condition is truthy', async () => {
      const res = await _when(
        (v: number) => v > 5,
        (v: number) => Promise.resolve(v * 2),
      )(10);
      expect(res).to.eq(20);
    });

    it('supports async condition', async () => {
      const res = await _when(
        async (v: number) => v > 5,
        (v: number) => Promise.resolve(v * 2),
      )(10);
      expect(res).to.eq(20);
    });
  });

  describe('_unless', () => {
    it('runs fn when condition is falsy', async () => {
      const res = await _unless(
        (v: number) => v > 5,
        (v: number) => Promise.resolve(v * 2),
      )(3);
      expect(res).to.eq(6);
    });
  });

  describe('_finally', () => {
    it('runs cleanup on success, result passes through', async () => {
      let cleaned = false;
      const res = await _finally(
        () => Promise.resolve('ok'),
        () => {
          cleaned = true;
        },
      )();
      expect(res).to.eq('ok');
      expect(cleaned).to.be.true;
    });
  });

  describe('_tapError', () => {
    it('observes error with original args and re-throws', async () => {
      let seen: unknown[] = [];
      await expect(
        _tapError(
          (_v: number) => Promise.reject(new Error('boom')),
          (err, v) => {
            seen = [err.message, v];
          },
        )(7),
      ).to.be.rejectedWith('boom');
      expect(seen).to.deep.eq(['boom', 7]);
    });
  });

  describe('_concurrent', () => {
    it('maps with at most `concurrency` callbacks in flight, preserving order', async () => {
      let active = 0;
      let maxActive = 0;

      const res = await _concurrent(async (v: number) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return v * 2;
      }, 2)([1, 2, 3, 4, 5]);

      expect(res).to.deep.eq([2, 4, 6, 8, 10]);
      expect(maxActive).to.be.at.most(2);
      expect(maxActive).to.be.at.least(2);
    });

    it('concurrency 1 behaves serially', async () => {
      let active = 0;
      let maxActive = 0;

      const res = await _concurrent(async (v: number) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 2));
        active--;
        return v + 1;
      }, 1)([1, 2, 3]);

      expect(res).to.deep.eq([2, 3, 4]);
      expect(maxActive).to.eq(1);
    });

    it('concurrency larger than input works', async () => {
      const res = await _concurrent(async (v: number) => v * v, 10)([1, 2, 3]);
      expect(res).to.deep.eq([1, 4, 9]);
    });

    it('preserves order even when later items finish first', async () => {
      const res = await _concurrent(async (v: number) => {
        await new Promise((r) => setTimeout(r, v));
        return v;
      }, 3)([30, 5, 15]);

      expect(res).to.deep.eq([30, 5, 15]);
    });

    it('rejects when a callback fails', async () => {
      await expect(
        _concurrent(async (v: number) => {
          if (v === 2) throw new Error('boom');
          return v;
        }, 2)([1, 2, 3]),
      ).to.be.rejectedWith('boom');
    });

    it('throws descriptive error on non-array input', () => {
      expect(() => _concurrent(async (v: number) => v, 2)(undefined as any)).to.throw(/_concurrent/);
    });

    it('throws on invalid concurrency', () => {
      expect(() => _concurrent(async (v: number) => v, 0)).to.throw(/concurrency/);
      expect(() => _concurrent(async (v: number) => v, -1)).to.throw(/concurrency/);
      expect(() => _concurrent(async (v: number) => v, 1.5)).to.throw(/concurrency/);
    });

    it('works inside a chain', async () => {
      const res = await _chain(
        () => [1, 2, 3, 4],
        _concurrent(async (v: number) => v * 10, 2),
      );
      expect(res).to.deep.eq([10, 20, 30, 40]);
    });
  });

  describe('_batch', () => {
    it('chunks array into batches of given size', () => {
      expect(_batch(3)([1, 2, 3, 4, 5, 6, 7])).to.deep.eq([
        [1, 2, 3],
        [4, 5, 6],
        [7],
      ]);
    });

    it('exact division leaves no remainder batch', () => {
      expect(_batch(2)([1, 2, 3, 4])).to.deep.eq([
        [1, 2],
        [3, 4],
      ]);
    });

    it('empty array yields no batches', () => {
      expect(_batch(3)([])).to.deep.eq([]);
    });

    it('size larger than input yields single batch', () => {
      expect(_batch(10)([1, 2])).to.deep.eq([[1, 2]]);
    });

    it('throws on invalid size', () => {
      expect(() => _batch(0)).to.throw(/size/);
      expect(() => _batch(-2)).to.throw(/size/);
      expect(() => _batch(1.5)).to.throw(/size/);
    });

    it('throws descriptive error on non-array input', () => {
      expect(() => _batch(2)(undefined as any)).to.throw(/_batch/);
    });

    it('composes with _sequence for batched processing', async () => {
      const processedBatches: number[][] = [];

      const res = await _chain(
        () => [1, 2, 3, 4, 5],
        _batch(2),
        _sequence(async (batch: number[]) => {
          processedBatches.push(batch);
          return batch.reduce((a, b) => a + b, 0);
        }),
      );

      expect(processedBatches).to.deep.eq([[1, 2], [3, 4], [5]]);
      expect(res).to.deep.eq([3, 7, 5]);
    });
  });

  describe('_or_else', () => {
    it('replaces null and undefined with default', async () => {
      expect(await _or_else('def')(null)).to.eq('def');
      expect(await _or_else('def')(undefined)).to.eq('def');
    });

    it('keeps non-nullish values, including falsy ones', async () => {
      expect(await _or_else('def')('x')).to.eq('x');
      expect(await _or_else<number | string, string>('def')(0)).to.eq(0);
      expect(await _or_else<string, string>('def')('')).to.eq('');
    });

    it('supports (async) factory default', async () => {
      expect(await _or_else(() => 'lazy')(null)).to.eq('lazy');
      expect(await _or_else(async () => 'lazy async')(undefined)).to.eq('lazy async');
    });
  });
});
