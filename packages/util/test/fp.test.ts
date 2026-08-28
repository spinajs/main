import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { expect } from 'chai';

import {
  _chain,
  _fanout,
  _map,
  _all,
  _use,
  _struct,
  _catch,
  _catchFilter,
  _catchValue,
  _catchException,
  _fallback,
  _tap,
  _ifElse,
  _toArray,
  _pipe,
  _filter,
  _reduce,
  _sequence,
  _race,
  _when,
  _unless,
  _finally,
  _tapError,
  _orElse,
  _concurrent,
  _batch,
  _rescue,
  _retry,
  _sleep,
  _timeout,
  TimeoutRejectedException,
  CanceledException,
} from '../src/index.js';

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
        (err) => err instanceof Error && err.message === 'sync',
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
          (err) => err instanceof Error && err.message === 'other',
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

  describe('error handler receives unknown', () => {
    it('_catch handler narrows thrown non-Error values', async () => {
      const a = () => {
        // eslint-disable-next-line no-throw-literal
        throw 'a string, not an Error';
      };

      const res = await _catch(a, (err) => (typeof err === 'string' ? err.toUpperCase() : 'not a string'))();
      expect(res).to.eq('A STRING, NOT AN ERROR');
    });
  });

  describe('_fallback', () => {
    it('passes through non-promise return value', async () => {
      const a = () => 5;

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

      const res = await _chain(() => 'A', _tap(sideEffect));
      expect(res).to.eq('A');
      expect(called).to.eq('A');
    });

    it('runs multiple steps sequentially, each fed the previous result', async () => {
      const order: unknown[] = [];

      const res = await _chain(
        () => 'A',
        _tap(
          (v) => {
            order.push(v);
            return 'B';
          },
          (v) => {
            order.push(v);
            return 'C';
          },
        ),
      );

      expect(res).to.eq('A');
      expect(order).to.deep.eq(['A', 'B']);
    });

    it('propagates side effect error', async () => {
      await expect(
        _chain(
          () => 'A',
          _tap(() => {
            throw new Error('side boom');
          }),
        ),
      ).to.be.rejectedWith('side boom');
    });
  });

  describe('_ifElse', () => {
    it('supports sync condition', async () => {
      const t = await _ifElse(
        (a: number) => a === 1,
        async () => 'yes',
        async () => 'no',
      )(1);
      expect(t).to.eq('yes');

      const f = await _ifElse(
        (a: number) => a === 1,
        async () => 'yes',
        async () => 'no',
      )(2);
      expect(f).to.eq('no');
    });

    it('supports async condition', async () => {
      const t = await _ifElse(
        async (a: number) => a === 1,
        async () => 'yes',
        async () => 'no',
      )(1);
      expect(t).to.eq('yes');
    });

    it('without else branch passes input through when condition is false', async () => {
      const r = await _ifElse(
        (a: number) => a > 10,
        async () => 'yes',
      )(7);
      expect(r).to.eq(7);
    });

    it('without else branch passes input through when async condition is false', async () => {
      const r = await _ifElse(
        async (a: number) => a > 10,
        async () => 'yes',
      )(7);
      expect(r).to.eq(7);
    });

    it('branches receive the input value', async () => {
      const r = await _ifElse(
        (a: number) => a > 0,
        (a) => a * 2,
        (a) => a * -1,
      )(21);
      expect(r).to.eq(42);
    });
  });

  describe('_map', () => {
    it('maps in parallel', async () => {
      const res = await _chain(
        () => [1, 2, 3],
        _map(async (v: number) => v * v),
      );
      expect(res).to.deep.eq([1, 4, 9]);
    });

    it('throws descriptive error on non-array input', () => {
      expect(() => _map(async (v: number) => v)(undefined as never)).to.throw(/_map/);
    });
  });

  describe('_chain', () => {
    it('with no steps resolves null', async () => {
      const res = await _chain();
      expect(res).to.be.null;
    });

    it('chains sync and async functions', async () => {
      const res = await _chain(
        () => 5,
        (v) => v + 1,
        (v) => Promise.resolve(v * 2),
      );
      expect(res).to.eq(12);
    });

    it('infers types through the chain without annotations', async () => {
      const res = await _chain(
        () => 5,
        (v) => v + 1,
        (v) => Promise.resolve(v * 2),
      );

      // compile-time proof: res is number, not unknown
      const typed: number = res;
      expect(typed).to.eq(12);
    });

    it('rejects when a step throws synchronously', async () => {
      await expect(
        _chain(
          () => 1,
          () => {
            throw new Error('boom');
          },
        ),
      ).to.be.rejectedWith('boom');
    });

    it('supports long chains beyond the typed overloads', async () => {
      const inc = (v: number) => v + 1;
      const res = await _chain(() => 0, inc, inc, inc, inc, inc, inc, inc, inc, inc, inc, inc, inc, inc);
      expect(res).to.eq(13);
    });
  });

  describe('_rescue', () => {
    it('catches upstream step error and continues chain with recovery value', async () => {
      const res = await _chain(
        () => Promise.reject(new Error('boom')),
        _rescue(() => 1),
        (v) => (v as number) + 1,
      );
      expect(res).to.eq(2);
    });

    it('catches errors from any upstream step', async () => {
      const res = await _chain(
        () => 1,
        () => {
          throw new Error('mid boom');
        },
        _rescue((err) => (err instanceof Error ? err.message : 'unknown')),
      );
      expect(res).to.eq('mid boom');
    });

    it('passes value through untouched on success', async () => {
      let called = false;
      const res = await _chain(
        () => 42,
        _rescue(() => {
          called = true;
          return 0;
        }),
      );
      expect(res).to.eq(42);
      expect(called).to.be.false;
    });

    it('errors after rescue are not caught by it', async () => {
      await expect(
        _chain(
          () => 1,
          _rescue(() => 0),
          () => {
            throw new Error('after');
          },
        ),
      ).to.be.rejectedWith('after');
    });
  });

  describe('_fanout', () => {
    it('with no functions resolves empty array', async () => {
      const res = await _chain(() => 1, _fanout());
      expect(res).to.be.an('array');
      expect(res).to.have.lengthOf(0);
    });

    it('passes chained value to all functions', async () => {
      const res = await _chain(
        () => 2,
        _fanout(
          async (v: number) => v + 1,
          async (v: number) => v * 10,
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

  describe('_toArray', () => {
    it('wraps single value', () => {
      expect(_toArray()(5)).to.deep.eq([5]);
    });

    it('keeps array reference', () => {
      const a = [1, 2];
      expect(_toArray()(a)).to.eq(a);
    });

    it('wraps null', () => {
      expect(_toArray<unknown>()(null)).to.deep.eq([null]);
    });
  });

  describe('_use', () => {
    it('builds up context across steps with inferred value types', async () => {
      const res = await _chain(
        _use(() => Promise.resolve('service A'), 'a'),
        _use(() => Promise.resolve(2), 'b'),
        ({ a, b }) => `${a.toUpperCase()}:${b.toFixed(0)}`,
      );
      expect(res).to.eq('SERVICE A:2');
    });

    it('starts a fresh context when accumulator is undefined', async () => {
      const res = await _use(() => Promise.resolve('x'), 'a')();
      expect(res).to.deep.eq({ a: 'x' });
    });

    it('throws on primitive accumulator instead of silently dropping it', async () => {
      await expect(_use(() => Promise.resolve('x'), 'a')(5 as never)).to.be.rejectedWith(/_use/);
    });
  });

  describe('_struct', () => {
    it('resolves all fields in parallel and merges them', async () => {
      let active = 0;
      let maxActive = 0;

      const track = async <T>(v: T): Promise<T> => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return v;
      };

      const res = await _struct({
        a: () => track('A'),
        b: () => track(2),
      })();

      expect(res).to.deep.eq({ a: 'A', b: 2 });
      expect(maxActive).to.eq(2);
    });

    it('each field function receives the chain input', async () => {
      const res = await _chain(
        _use(() => Promise.resolve(2), 'base'),
        _struct({
          doubled: (ctx) => (ctx as { base: number }).base * 2,
          tripled: (ctx) => (ctx as { base: number }).base * 3,
        }),
      );

      expect(res).to.deep.eq({ base: 2, doubled: 4, tripled: 6 });
    });

    it('rejects when any field rejects', async () => {
      await expect(
        _struct({
          ok: () => Promise.resolve(1),
          bad: () => Promise.reject(new Error('field boom')),
        })(),
      ).to.be.rejectedWith('field boom');
    });

    it('throws on primitive accumulator', async () => {
      await expect(_struct({ a: () => 1 })(5 as never)).to.be.rejectedWith(/_struct/);
    });
  });

  describe('_catch recovery', () => {
    it('recovery value continues chain', async () => {
      const res = await _chain(
        _catch(
          () => Promise.reject(new Error('x')),
          async () => 1,
        ),
        (v) => (v as number) + 1,
      );
      expect(res).to.eq(2);
    });
  });

  describe('_pipe', () => {
    it('composes reusable pipeline, arg fed to first step', async () => {
      const pipeline = _pipe(
        (v: number) => v + 1,
        (v) => Promise.resolve(v * 2),
      );

      expect(await pipeline(2)).to.eq(6);
      expect(await pipeline(5)).to.eq(12);
    });

    it('infers result type from last step', async () => {
      const pipeline = _pipe(
        (v: number) => v + 1,
        (v) => `${v}`,
      );

      // compile-time proof: result is string
      const typed: string = await pipeline(1);
      expect(typed).to.eq('2');
    });

    it('rejects when a step fails', async () => {
      const pipeline = _pipe(() => Promise.reject(new Error('boom')));
      await expect(pipeline(undefined)).to.be.rejectedWith('boom');
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
      expect(() => _filter((v: number) => v > 0)(undefined as never)).to.throw(/_filter/);
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
      expect(() => _reduce((acc: number, v: number) => acc + v, 0)(undefined as never)).to.throw(/_reduce/);
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
      expect(() => _sequence(async (v: number) => v)(undefined as never)).to.throw(/_sequence/);
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
        (v) => Promise.resolve(v * 2),
      )(10);
      expect(res).to.eq(20);
    });

    it('passes value through when condition is falsy', async () => {
      const res = await _when(
        (v: number) => v > 5,
        (v) => Promise.resolve(v * 2),
      )(3);
      expect(res).to.eq(3);
    });

    it('supports async condition', async () => {
      const res = await _when(
        async (v: number) => v > 5,
        (v) => Promise.resolve(v * 2),
      )(10);
      expect(res).to.eq(20);
    });
  });

  describe('_unless', () => {
    it('runs fn when condition is falsy', async () => {
      const res = await _unless(
        (v: number) => v > 5,
        (v) => Promise.resolve(v * 2),
      )(3);
      expect(res).to.eq(6);
    });

    it('passes value through when condition is truthy', async () => {
      const res = await _unless(
        (v: number) => v > 5,
        (v) => Promise.resolve(v * 2),
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
            seen = [err instanceof Error ? err.message : 'unknown', v];
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

    it('by default keeps processing remaining items after a failure', async () => {
      const called: number[] = [];

      await expect(
        _concurrent(async (v: number) => {
          called.push(v);
          if (v === 1) {
            await new Promise((r) => setTimeout(r, 5));
            throw new Error('boom');
          }
          await new Promise((r) => setTimeout(r, 30));
          return v;
        }, 2)([1, 2, 3, 4]),
      ).to.be.rejectedWith('boom');

      // surviving worker claims items 3 and 4 after the failure
      await new Promise((r) => setTimeout(r, 100));
      expect(called).to.include(3);
    });

    it('with failFast stops claiming new items after a failure', async () => {
      const called: number[] = [];

      await expect(
        _concurrent(
          async (v: number) => {
            called.push(v);
            if (v === 1) {
              await new Promise((r) => setTimeout(r, 5));
              throw new Error('boom');
            }
            await new Promise((r) => setTimeout(r, 30));
            return v;
          },
          2,
          { failFast: true },
        )([1, 2, 3, 4]),
      ).to.be.rejectedWith('boom');

      await new Promise((r) => setTimeout(r, 100));
      expect(called).to.not.include(3);
      expect(called).to.not.include(4);
    });

    it('rejects immediately when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort(new CanceledException('canceled'));

      await expect(_concurrent(async (v: number) => v, 2, { signal: controller.signal })([1, 2, 3])).to.be.rejectedWith(CanceledException);
    });

    it('stops claiming new items when signal aborts mid-flight', async () => {
      const controller = new AbortController();
      const called: number[] = [];

      const pending = _concurrent(
        async (v: number) => {
          called.push(v);
          await new Promise((r) => setTimeout(r, 20));
          return v;
        },
        1,
        { signal: controller.signal },
      )([1, 2, 3]);

      setTimeout(() => controller.abort(), 5);

      await expect(pending).to.be.rejected;
      await new Promise((r) => setTimeout(r, 80));
      expect(called).to.not.include(2);
    });

    it('throws descriptive error on non-array input', () => {
      expect(() => _concurrent(async (v: number) => v, 2)(undefined as never)).to.throw(/_concurrent/);
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
      expect(() => _batch(2)(undefined as never)).to.throw(/_batch/);
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

  describe('_orElse', () => {
    it('replaces null and undefined with default', async () => {
      expect(await _orElse('def')(null)).to.eq('def');
      expect(await _orElse('def')(undefined)).to.eq('def');
    });

    it('keeps non-nullish values, including falsy ones', async () => {
      expect(await _orElse('def')('x')).to.eq('x');
      expect(await _orElse<number | string, string>('def')(0)).to.eq(0);
      expect(await _orElse<string, string>('def')('')).to.eq('');
    });

    it('supports (async) factory default', async () => {
      expect(await _orElse(() => 'lazy')(null)).to.eq('lazy');
      expect(await _orElse(async () => 'lazy async')(undefined)).to.eq('lazy async');
    });

    it('works inside a chain', async () => {
      const res = await _chain(() => null, _orElse('fallback'));
      expect(res).to.eq('fallback');
    });
  });

  describe('_retry', () => {
    it('retries until success within attempts', async () => {
      let calls = 0;
      const flaky = () => {
        calls++;
        if (calls < 3) {
          throw new Error('flaky');
        }
        return 'ok';
      };

      const res = await _retry(flaky, { attempts: 3, delay: 1 })();
      expect(res).to.eq('ok');
      expect(calls).to.eq(3);
    });

    it('rejects with last error when attempts are exhausted', async () => {
      let calls = 0;
      const alwaysFails = () => {
        calls++;
        throw new Error(`fail ${calls}`);
      };

      await expect(_retry(alwaysFails, { attempts: 2, delay: 1 })()).to.be.rejectedWith('fail 2');
      expect(calls).to.eq(2);
    });

    it('does not retry when retryIf rejects the error', async () => {
      let calls = 0;
      const fails = () => {
        calls++;
        throw new Error('fatal');
      };

      await expect(
        _retry(fails, {
          attempts: 5,
          delay: 1,
          retryIf: (err) => err instanceof Error && err.message === 'transient',
        })(),
      ).to.be.rejectedWith('fatal');
      expect(calls).to.eq(1);
    });

    it('passes original args on every attempt', async () => {
      let calls = 0;
      const flaky = (v: number) => {
        calls++;
        if (calls < 2) {
          throw new Error('flaky');
        }
        return v * 2;
      };

      const res = await _retry(flaky, { attempts: 3, delay: 1 })(21);
      expect(res).to.eq(42);
    });

    it('throws on invalid attempts', () => {
      expect(() => _retry(() => 1, { attempts: 0 })).to.throw(/attempts/);
      expect(() => _retry(() => 1, { attempts: 1.5 })).to.throw(/attempts/);
    });
  });

  describe('_sleep', () => {
    it('passes value through after the delay', async () => {
      const started = Date.now();
      const res = await _chain(() => 'A', _sleep(20));
      const elapsed = Date.now() - started;

      expect(res).to.eq('A');
      expect(elapsed).to.be.at.least(15);
    });

    it('throws on invalid duration', () => {
      expect(() => _sleep(-1)).to.throw(/_sleep/);
    });
  });

  describe('_timeout', () => {
    it('resolves when operation completes in time', async () => {
      const res = await _timeout(async (v: number) => {
        await new Promise((r) => setTimeout(r, 5));
        return v * 2;
      }, 100)(21);
      expect(res).to.eq(42);
    });

    it('rejects with TimeoutRejectedException when operation is too slow', async () => {
      await expect(
        _timeout(async () => {
          await new Promise((r) => setTimeout(r, 100));
          return 'late';
        }, 20)(),
      ).to.be.rejectedWith(TimeoutRejectedException);
    });

    it('throws on invalid duration', () => {
      expect(() => _timeout(() => 1, 0)).to.throw(/_timeout/);
    });
  });
});
