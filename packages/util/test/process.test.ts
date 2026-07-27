import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { expect } from 'chai';
import { InvalidArgument } from '@spinajs/exceptions';
import { sleep, nextTick, withTimeout, onShutdown, runShutdown, clearShutdownHandlers, envString, envInt, envBool, envRequired, TimeSpan } from '../src/index.js';

chai.use(chaiAsPromised);

describe('process utilities', () => {
  describe('async / timing', () => {
    it('sleep waits at least the given span', async () => {
      const start = Date.now();
      await sleep(20);
      expect(Date.now() - start).to.be.gte(15);
    });

    it('sleep accepts a TimeSpan', async () => {
      const start = Date.now();
      await sleep(TimeSpan.fromMilliseconds(15));
      expect(Date.now() - start).to.be.gte(10);
    });

    it('nextTick resolves on a later turn', async () => {
      let flag = false;
      const p = nextTick().then(() => (flag = true));
      expect(flag).to.be.false;
      await p;
      expect(flag).to.be.true;
    });

    it('withTimeout resolves when the promise is fast', async () => {
      const result = await withTimeout(Promise.resolve('ok'), 50);
      expect(result).to.eq('ok');
    });

    it('withTimeout rejects when the span elapses first', async () => {
      const never = new Promise<number>(() => undefined);
      await expect(withTimeout(never, 10)).to.be.rejectedWith(/timed out/);
    });

    it('withTimeout rejects with the provided error', async () => {
      const never = new Promise<number>(() => undefined);
      const custom = new Error('mine');
      await expect(withTimeout(never, 10, custom)).to.be.rejectedWith('mine');
    });

    it('withTimeout propagates the underlying rejection', async () => {
      await expect(withTimeout(Promise.reject(new Error('inner')), 50)).to.be.rejectedWith('inner');
    });
  });

  describe('graceful shutdown', () => {
    afterEach(() => clearShutdownHandlers());

    it('runs handlers in LIFO order', async () => {
      const order: number[] = [];
      onShutdown(() => void order.push(1));
      onShutdown(() => void order.push(2));
      onShutdown(() => void order.push(3));

      await runShutdown();
      expect(order).to.deep.eq([3, 2, 1]);
    });

    it('awaits async handlers', async () => {
      const order: string[] = [];
      onShutdown(async () => {
        await sleep(10);
        order.push('slow');
      });
      onShutdown(() => void order.push('fast'));

      await runShutdown();
      expect(order).to.deep.eq(['fast', 'slow']);
    });

    it('runs only once even if called repeatedly', async () => {
      let calls = 0;
      onShutdown(() => void calls++);
      await runShutdown();
      await runShutdown();
      expect(calls).to.eq(1);
    });

    it('isolates a failing handler and reports it', async () => {
      const ran: string[] = [];
      const errors: string[] = [];
      onShutdown(() => void ran.push('a'), { name: 'a' });
      onShutdown(() => {
        throw new Error('boom');
      }, { name: 'b' });
      onShutdown(() => void ran.push('c'), { name: 'c' });

      await runShutdown((_e, name) => errors.push(name));
      // c registered last -> runs first; b throws (isolated); a still runs
      expect(ran).to.deep.eq(['c', 'a']);
      expect(errors).to.deep.eq(['b']);
    });

    it('unregister removes a handler', async () => {
      const ran: string[] = [];
      const off = onShutdown(() => void ran.push('x'));
      onShutdown(() => void ran.push('y'));
      off();

      await runShutdown();
      expect(ran).to.deep.eq(['y']);
    });
  });

  describe('env parsing', () => {
    const KEY = 'SPINAJS_UTIL_TEST_ENV';
    afterEach(() => {
      delete process.env[KEY];
    });

    it('envString reads value or default', () => {
      expect(envString(KEY, 'def')).to.eq('def');
      process.env[KEY] = 'hi';
      expect(envString(KEY)).to.eq('hi');
    });

    it('envRequired throws when missing / empty', () => {
      expect(() => envRequired(KEY)).to.throw(InvalidArgument);
      process.env[KEY] = '';
      expect(() => envRequired(KEY)).to.throw(InvalidArgument);
      process.env[KEY] = 'v';
      expect(envRequired(KEY)).to.eq('v');
    });

    it('envInt parses / defaults / validates', () => {
      expect(envInt(KEY, 7)).to.eq(7);
      process.env[KEY] = '42';
      expect(envInt(KEY)).to.eq(42);
      process.env[KEY] = 'nope';
      expect(() => envInt(KEY)).to.throw(InvalidArgument);
    });

    it('envBool parses truthy / falsy tokens', () => {
      expect(envBool(KEY, true)).to.eq(true);
      for (const t of ['true', '1', 'YES', 'on']) {
        process.env[KEY] = t;
        expect(envBool(KEY), t).to.eq(true);
      }
      for (const f of ['false', '0', 'no', 'OFF']) {
        process.env[KEY] = f;
        expect(envBool(KEY), f).to.eq(false);
      }
      process.env[KEY] = 'maybe';
      expect(() => envBool(KEY)).to.throw(InvalidArgument);
    });
  });
});
