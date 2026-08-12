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

    it('_catch passes original args to handler on sync throw', async () => {
      const a = (_v: number) => {
        throw new Error('sync');
      };

      const res = await _catch(a, async (_err, v) => v)(42);
      expect(res).to.eq(42);
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

  describe('_fallback', () => {
    it('passes through non-promise return value', async () => {
      const a = () => 5 as any;

      const res = await _fallback(a, () => 0)();
      expect(res).to.eq(5);
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

    it('without onRejected resolves null when sync condition is false', async () => {
      const r = await _either(
        (a) => !!a,
        async () => 'yes',
      )(0);
      expect(r).to.be.null;
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
    it('resolves raw promise element to its value', async () => {
      const res = await _chain(Promise.resolve(42));
      expect(res).to.eq(42);
    });

    it('with no steps resolves null', async () => {
      const res = await _chain();
      expect(res).to.be.null;
    });

    it('accepts plain values and sync functions', async () => {
      const res = await _chain(
        5,
        (v: number) => v + 1,
        (v: number) => Promise.resolve(v * 2),
      );
      expect(res).to.eq(12);
    });

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
    it('with no functions resolves empty array', async () => {
      const res = await _chain(1, _zip());
      expect(res).to.be.an('array');
      expect(res).to.have.lengthOf(0);
    });

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

    it('keeps array reference', () => {
      const a = [1, 2];
      expect(_to_array()(a)).to.eq(a);
    });

    it('wraps null', () => {
      expect(_to_array<unknown>()(null)).to.deep.eq([null]);
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

  describe('_catch recovery', () => {
    it('recovery value continues chain', async () => {
      const res = await _chain(
        _catch(
          () => Promise.reject(new Error('x')),
          async () => 1,
        ),
        (v: any) => v + 1,
      );
      expect(res).to.eq(2);
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

    it('accepts values and promises as steps like _chain', async () => {
      const pipeline = _pipe<number>(10, (v: number) => v + 1);
      expect(await pipeline()).to.eq(11);
    });

    it('rejects when a step fails', async () => {
      const pipeline = _pipe(() => Promise.reject(new Error('boom')));
      await expect(pipeline()).to.be.rejectedWith('boom');
    });
  });

  describe('_filter', () => {
    it('filters with async predicate preserving order', async () => {
      const res = await _filter(async (v: number) => v % 2 === 0)([1, 2, 3, 4, 5, 6]);
      expect(res).to.deep.eq([2, 4, 6]);
    });

    it('filters with sync predicate', async () => {
      const res = await _filter((v: number) => v > 2)([1, 2, 3, 4]);
      expect(res).to.deep.eq([3, 4]);
    });

    it('throws descriptive error on non-array input', () => {
      expect(() => _filter((v: number) => v > 0)(undefined as any)).to.throw(/_filter/);
    });

    it('works inside a chain', async () => {
      const res = await _chain(
        () => [1, 2, 3, 4],
        _filter(async (v: number) => v % 2 === 0),
      );
      expect(res).to.deep.eq([2, 4]);
    });
  });

  describe('_reduce', () => {
    it('reduces with async reducer starting from initial', async () => {
      const res = await _reduce(async (acc: number, v: number) => acc + v, 10)([1, 2, 3]);
      expect(res).to.eq(16);
    });

    it('processes elements serially in order', async () => {
      const order: number[] = [];
      await _reduce(async (acc: number, v: number) => {
        order.push(v);
        return acc;
      }, 0)([3, 1, 2]);
      expect(order).to.deep.eq([3, 1, 2]);
    });

    it('returns initial for empty array', async () => {
      const res = await _reduce((acc: number, v: number) => acc + v, 5)([]);
      expect(res).to.eq(5);
    });

    it('throws descriptive error on non-array input', () => {
      expect(() => _reduce((acc: number, v: number) => acc + v, 0)(undefined as any)).to.throw(/_reduce/);
    });
  });

  describe('_sequence', () => {
    it('maps serially - never runs callbacks concurrently', async () => {
      let active = 0;
      let maxActive = 0;

      const res = await _sequence(async (v: number) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return v * 2;
      })([1, 2, 3]);

      expect(res).to.deep.eq([2, 4, 6]);
      expect(maxActive).to.eq(1);
    });

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

    it('passes input value to all contestants', async () => {
      const res = await _race((v: number) => Promise.resolve(v + 1))(41);
      expect(res).to.eq(42);
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

    it('passes value through when condition is falsy', async () => {
      const res = await _when(
        (v: number) => v > 5,
        (v: number) => Promise.resolve(v * 2),
      )(3);
      expect(res).to.eq(3);
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

    it('passes value through when condition is truthy', async () => {
      const res = await _unless(
        (v: number) => v > 5,
        (v: number) => Promise.resolve(v * 2),
      )(10);
      expect(res).to.eq(10);
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

    it('runs cleanup on failure, error propagates', async () => {
      let cleaned = false;
      await expect(
        _finally(
          () => Promise.reject(new Error('boom')),
          () => {
            cleaned = true;
          },
        )(),
      ).to.be.rejectedWith('boom');
      expect(cleaned).to.be.true;
    });

    it('runs cleanup on sync throw', async () => {
      let cleaned = false;
      await expect(
        _finally(
          () => {
            throw new Error('sync');
          },
          () => {
            cleaned = true;
          },
        )(),
      ).to.be.rejectedWith('sync');
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

    it('does not call handler on success', async () => {
      let called = false;
      const res = await _tapError(
        () => Promise.resolve('ok'),
        () => {
          called = true;
        },
      )();
      expect(res).to.eq('ok');
      expect(called).to.be.false;
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

    it('empty array resolves empty', async () => {
      const res = await _concurrent(async (v: number) => v, 2)([]);
      expect(res).to.deep.eq([]);
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

    it('works inside a chain', async () => {
      const res = await _chain(() => null, _or_else('fallback'));
      expect(res).to.eq('fallback');
    });
  });
});
