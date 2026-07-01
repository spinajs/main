import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { IOFail } from '@spinajs/exceptions';
import {
  ResiliencePipelineBuilder,
  PredicateBuilder,
  BackoffType,
  TimeoutRejectedException,
  BrokenCircuitException,
  IsolatedCircuitException,
  RateLimiterRejectedException,
  CircuitBreakerManualControl,
  TimeSpan,
} from '../src/index.js';

chai.use(chaiAsPromised);

/**
 * Runs `fn` while advancing sinon fake timers so that any pending timeouts
 * ( retry delays, breaker windows, hedging staggers ) resolve deterministically.
 */
async function withFakeTime<T>(clock: sinon.SinonFakeTimers, fn: () => PromiseLike<T>): Promise<T> {
  const p = Promise.resolve(fn());
  // drain microtasks + timers until the promise settles
  let settled = false;
  void p.then(
    () => (settled = true),
    () => (settled = true),
  );
  while (!settled) {
    await clock.tickAsync(50);
  }
  return p;
}

describe('resilience', () => {
  describe('retry', () => {
    it('succeeds without retry when action succeeds', async () => {
      const action = sinon.stub().resolves('ok');
      const pipeline = new ResiliencePipelineBuilder<string>().addRetry({ MaxRetryAttempts: 3 }).build();

      const res = await pipeline.execute(() => action());

      expect(res).to.eq('ok');
      expect(action.callCount).to.eq(1);
    });

    it('retries up to MaxRetryAttempts then rethrows', async () => {
      const clock = sinon.useFakeTimers();
      try {
        const action = sinon.stub().rejects(new IOFail('boom'));
        const pipeline = new ResiliencePipelineBuilder<string>().addRetry({ MaxRetryAttempts: 2, Delay: 10 }).build();

        await withFakeTime(clock, () => expect(pipeline.execute(() => action())).to.be.rejectedWith('boom'));

        // 1 original + 2 retries
        expect(action.callCount).to.eq(3);
      } finally {
        clock.restore();
      }
    });

    it('recovers on a later attempt', async () => {
      const clock = sinon.useFakeTimers();
      try {
        const action = sinon.stub();
        action.onCall(0).rejects(new IOFail('1'));
        action.onCall(1).rejects(new IOFail('2'));
        action.onCall(2).resolves('recovered');

        const pipeline = new ResiliencePipelineBuilder<string>().addRetry({ MaxRetryAttempts: 5, Delay: 10 }).build();

        const res = await withFakeTime(clock, () => pipeline.execute(() => action()));

        expect(res).to.eq('recovered');
        expect(action.callCount).to.eq(3);
      } finally {
        clock.restore();
      }
    });

    it('only handles configured errors', async () => {
      class OtherError extends Error {}
      const action = sinon.stub().rejects(new OtherError('nope'));
      const pipeline = new ResiliencePipelineBuilder<string>()
        .addRetry({ MaxRetryAttempts: 3, Delay: 1, ShouldHandle: new PredicateBuilder<string>().handle(IOFail) })
        .build();

      await expect(pipeline.execute(() => action())).to.be.rejectedWith('nope');
      // not handled -> no retry
      expect(action.callCount).to.eq(1);
    });

    it('can retry on a handled result value', async () => {
      const clock = sinon.useFakeTimers();
      try {
        const action = sinon.stub();
        action.onCall(0).resolves(-1);
        action.onCall(1).resolves(42);

        const pipeline = new ResiliencePipelineBuilder<number>()
          .addRetry({ MaxRetryAttempts: 3, Delay: 5, ShouldHandle: new PredicateBuilder<number>().handleResult((r) => r < 0) })
          .build();

        const res = await withFakeTime(clock, () => pipeline.execute(() => action()));
        expect(res).to.eq(42);
        expect(action.callCount).to.eq(2);
      } finally {
        clock.restore();
      }
    });

    it('honors BackoffType.Exponential enum for growing delays', async () => {
      const clock = sinon.useFakeTimers();
      try {
        const delays: number[] = [];
        const action = sinon.stub().rejects(new IOFail('x'));
        const pipeline = new ResiliencePipelineBuilder<string>()
          .addRetry({
            MaxRetryAttempts: 3,
            Delay: 100,
            BackoffType: BackoffType.Exponential,
            OnRetry: ({ RetryDelay }) => {
              delays.push(RetryDelay.totalMilliseconds);
            },
          })
          .build();

        await withFakeTime(clock, () => expect(pipeline.execute(() => action())).to.be.rejected);

        // exponential: 100, 200, 400
        expect(delays).to.deep.equal([100, 200, 400]);
      } finally {
        clock.restore();
      }
    });

    it('invokes OnRetry with attempt numbers', async () => {
      const clock = sinon.useFakeTimers();
      try {
        const onRetry = sinon.stub().resolves();
        const action = sinon.stub().rejects(new IOFail('x'));
        const pipeline = new ResiliencePipelineBuilder<string>().addRetry({ MaxRetryAttempts: 2, Delay: 10, OnRetry: onRetry }).build();

        await withFakeTime(clock, () => expect(pipeline.execute(() => action())).to.be.rejected);

        expect(onRetry.callCount).to.eq(2);
        expect(onRetry.firstCall.args[0].AttemptNumber).to.eq(1);
        expect(onRetry.secondCall.args[0].AttemptNumber).to.eq(2);
      } finally {
        clock.restore();
      }
    });
  });

  describe('timeout', () => {
    it('passes through fast operations', async () => {
      const pipeline = new ResiliencePipelineBuilder<string>().addTimeout(TimeSpan.fromSeconds(1)).build();
      const res = await pipeline.execute(() => Promise.resolve('fast'));
      expect(res).to.eq('fast');
    });

    it('throws TimeoutRejectedException on slow operations', async () => {
      const clock = sinon.useFakeTimers();
      try {
        const pipeline = new ResiliencePipelineBuilder<string>().addTimeout(100).build();
        await withFakeTime(clock, () =>
          expect(
            pipeline.execute(
              (ctx) =>
                new Promise<string>((resolve) => {
                  const t = setTimeout(() => resolve('slow'), 10_000);
                  ctx.Signal.addEventListener('abort', () => clearTimeout(t));
                }),
            ),
          ).to.be.rejectedWith(TimeoutRejectedException),
        );
      } finally {
        clock.restore();
      }
    });

    it('aborts the context signal on timeout', async () => {
      const clock = sinon.useFakeTimers();
      try {
        let aborted = false;
        const pipeline = new ResiliencePipelineBuilder<string>().addTimeout(100).build();
        await withFakeTime(clock, () =>
          expect(
            pipeline.execute(
              (ctx) =>
                new Promise<string>(() => {
                  // never resolves on its own - only observes the abort flag
                  ctx.Signal.addEventListener('abort', () => {
                    aborted = true;
                  });
                }),
            ),
          ).to.be.rejectedWith(TimeoutRejectedException),
        );
        expect(aborted).to.be.true;
      } finally {
        clock.restore();
      }
    });
  });

  describe('fallback', () => {
    it('returns fallback value on handled error', async () => {
      const pipeline = new ResiliencePipelineBuilder<string>()
        .addFallback({ FallbackAction: () => Promise.resolve('fallback') })
        .build();

      const res = await pipeline.execute(() => Promise.reject(new IOFail('fail')));
      expect(res).to.eq('fallback');
    });

    it('does not trigger when unhandled', async () => {
      class OtherError extends Error {}
      const pipeline = new ResiliencePipelineBuilder<string>()
        .addFallback({ ShouldHandle: new PredicateBuilder<string>().handle(IOFail), FallbackAction: () => Promise.resolve('fallback') })
        .build();

      await expect(pipeline.execute(() => Promise.reject(new OtherError('other')))).to.be.rejectedWith('other');
    });
  });

  describe('circuit breaker', () => {
    it('opens after failure threshold and rejects fast', async () => {
      const clock = sinon.useFakeTimers();
      try {
        const action = sinon.stub().rejects(new IOFail('down'));
        const pipeline = new ResiliencePipelineBuilder<string>()
          .addCircuitBreaker({ FailureRatio: 0.5, MinimumThroughput: 2, SamplingDuration: TimeSpan.fromSeconds(10), BreakDuration: TimeSpan.fromSeconds(1) })
          .build();

        await expect(pipeline.execute(() => action())).to.be.rejectedWith('down');
        await expect(pipeline.execute(() => action())).to.be.rejectedWith('down');
        // circuit should now be open -> fast reject without calling action again
        await expect(pipeline.execute(() => action())).to.be.rejectedWith(BrokenCircuitException);

        expect(action.callCount).to.eq(2);

        // after break duration, half-open allows a trial
        await clock.tickAsync(1100);
        action.resetHistory();
        action.resolves('up');
        const res = await pipeline.execute(() => action());
        expect(res).to.eq('up');
        expect(action.callCount).to.eq(1);
      } finally {
        clock.restore();
      }
    });

    it('manual isolate rejects with IsolatedCircuitException', async () => {
      const control = new CircuitBreakerManualControl();
      const pipeline = new ResiliencePipelineBuilder<string>().addCircuitBreaker({ ManualControl: control }).build();

      control.isolate();
      await expect(pipeline.execute(() => Promise.resolve('x'))).to.be.rejectedWith(IsolatedCircuitException);

      control.reset();
      const res = await pipeline.execute(() => Promise.resolve('x'));
      expect(res).to.eq('x');
    });
  });

  describe('concurrency limiter', () => {
    it('rejects when over the permit limit with empty queue', async () => {
      const pipeline = new ResiliencePipelineBuilder<string>().addConcurrencyLimiter({ PermitLimit: 1, QueueLimit: 0 }).build();

      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));

      const first = pipeline.execute(() => gate.then(() => 'first'));
      const second = pipeline.execute(() => Promise.resolve('second'));

      await expect(second).to.be.rejectedWith(RateLimiterRejectedException);

      release();
      expect(await first).to.eq('first');
    });

    it('queues when capacity allows', async () => {
      const pipeline = new ResiliencePipelineBuilder<string>().addConcurrencyLimiter({ PermitLimit: 1, QueueLimit: 1 }).build();

      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));

      const first = pipeline.execute(() => gate.then(() => 'first'));
      const second = pipeline.execute(() => Promise.resolve('second'));

      release();
      expect(await first).to.eq('first');
      expect(await second).to.eq('second');
    });
  });

  describe('hedging', () => {
    it('returns the first successful attempt', async () => {
      const clock = sinon.useFakeTimers();
      try {
        const action = sinon.stub();
        // first attempt slow, hedged attempt fast
        action.onCall(0).callsFake(() => new Promise((resolve) => setTimeout(() => resolve('slow'), 10_000)));
        action.onCall(1).resolves('fast');

        const pipeline = new ResiliencePipelineBuilder<string>().addHedging({ MaxHedgedAttempts: 1, Delay: 100 }).build();

        const res = await withFakeTime(clock, () => pipeline.execute(() => action()));
        expect(res).to.eq('fast');
      } finally {
        clock.restore();
      }
    });

    it('hedges immediately on handled failure', async () => {
      const action = sinon.stub();
      action.onCall(0).rejects(new IOFail('first failed'));
      action.onCall(1).resolves('second ok');

      const pipeline = new ResiliencePipelineBuilder<string>().addHedging({ MaxHedgedAttempts: 1, Delay: 10_000 }).build();

      const res = await pipeline.execute(() => action());
      expect(res).to.eq('second ok');
      expect(action.callCount).to.eq(2);
    });
  });

  describe('pipeline composition', () => {
    it('retry wraps timeout (each attempt is time-bounded)', async () => {
      const clock = sinon.useFakeTimers();
      try {
        const action = sinon.stub();
        action.onCall(0).callsFake(
          (ctx: { Signal: AbortSignal }) =>
            new Promise((resolve) => {
              const t = setTimeout(() => resolve('slow'), 10_000);
              ctx.Signal.addEventListener('abort', () => clearTimeout(t));
            }),
        );
        action.onCall(1).resolves('quick');

        const pipeline = new ResiliencePipelineBuilder<string>()
          .addRetry({ MaxRetryAttempts: 2, Delay: 10 })
          .addTimeout(100)
          .build();

        const res = await withFakeTime(clock, () => pipeline.execute((ctx) => action(ctx)));
        expect(res).to.eq('quick');
        expect(action.callCount).to.eq(2);
      } finally {
        clock.restore();
      }
    });
  });
});
