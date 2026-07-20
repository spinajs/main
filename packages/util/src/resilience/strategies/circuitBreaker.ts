import { TimeSpan, TimeSpanLike } from '../../timespan.js';
import { Outcome, ResilienceStrategy, ShouldHandle, _capture, _resolveShouldHandle, _toTimeSpan, _unwrap } from '../core.js';
import { BrokenCircuitException, IsolatedCircuitException } from '../exceptions.js';

export type CircuitState = 'Closed' | 'Open' | 'HalfOpen' | 'Isolated';

/**
 * Allows manual control of a circuit breaker from the outside.
 * Pass an instance via {@link CircuitBreakerStrategyOptions.ManualControl}.
 */
export class CircuitBreakerManualControl {
  /** @internal */
  public _onIsolate?: () => void;
  /** @internal */
  public _onReset?: () => void;

  /**
   * Force the circuit open ( Isolated ). All calls are rejected until {@link reset}.
   */
  public isolate(): void {
    this._onIsolate?.();
  }

  /**
   * Close the circuit and reset its health metrics.
   */
  public reset(): void {
    this._onReset?.();
  }
}

export interface CircuitBreakerStrategyOptions<T> {
  /**
   * What errors / results count as failures. Defaults to "any exception".
   */
  ShouldHandle?: ShouldHandle<T>;

  /**
   * Failure ratio ( 0..1 ) within the sampling window that trips the circuit. Default 0.1.
   */
  FailureRatio?: number;

  /**
   * Minimum number of actions in the sampling window before the ratio is evaluated. Default 100.
   */
  MinimumThroughput?: number;

  /**
   * Length of the rolling window over which failures are measured. Default 30 seconds.
   */
  SamplingDuration?: TimeSpanLike;

  /**
   * How long the circuit stays open before allowing a trial call. Default 5 seconds.
   */
  BreakDuration?: TimeSpanLike;

  /**
   * Optional external control handle.
   */
  ManualControl?: CircuitBreakerManualControl;

  OnOpened?: (args: { Outcome?: Outcome<T>; BreakDuration: TimeSpan }) => void | Promise<void>;
  OnClosed?: () => void | Promise<void>;
  OnHalfOpened?: () => void | Promise<void>;
}

interface Sample {
  at: number;
  ok: boolean;
}

/**
 * Stops calling a failing operation once a failure threshold is reached, giving it time to recover.
 *
 * State machine: Closed -> Open ( on threshold ) -> HalfOpen ( after break duration )
 * -> Closed ( trial succeeds ) or Open ( trial fails ). Can be forced to Isolated via manual control.
 */
export function circuitBreakerStrategy<T>(options: CircuitBreakerStrategyOptions<T> = {}): ResilienceStrategy<T> {
  const failureRatio = options.FailureRatio ?? 0.1;
  const minimumThroughput = options.MinimumThroughput ?? 100;
  const samplingDuration = _toTimeSpan(options.SamplingDuration, TimeSpan.fromSeconds(30));
  const breakDuration = _toTimeSpan(options.BreakDuration, TimeSpan.fromSeconds(5));
  const shouldHandle = _resolveShouldHandle(options.ShouldHandle);

  let state: CircuitState = 'Closed';
  let samples: Sample[] = [];
  let openedAt = 0;
  let halfOpenTrialInProgress = false;

  const open = async (outcome?: Outcome<T>) => {
    state = 'Open';
    openedAt = Date.now();
    samples = [];
    await options.OnOpened?.({ Outcome: outcome, BreakDuration: breakDuration });
  };

  const close = async () => {
    const wasOpen = state !== 'Closed';
    state = 'Closed';
    samples = [];
    halfOpenTrialInProgress = false;
    if (wasOpen) {
      await options.OnClosed?.();
    }
  };

  if (options.ManualControl) {
    options.ManualControl._onIsolate = () => {
      state = 'Isolated';
      samples = [];
    };
    options.ManualControl._onReset = () => {
      void close();
    };
  }

  const prune = (now: number) => {
    const cutoff = now - samplingDuration.totalMilliseconds;
    samples = samples.filter((s) => s.at >= cutoff);
  };

  return (next) => async (ctx) => {
    const now = Date.now();

    if (state === 'Isolated') {
      throw new IsolatedCircuitException('Circuit is isolated and not allowing calls');
    }

    if (state === 'Open') {
      if (now - openedAt >= breakDuration.totalMilliseconds) {
        state = 'HalfOpen';
        halfOpenTrialInProgress = false;
        await options.OnHalfOpened?.();
      } else {
        throw new BrokenCircuitException('Circuit is open and not allowing calls');
      }
    }

    if (state === 'HalfOpen') {
      if (halfOpenTrialInProgress) {
        throw new BrokenCircuitException('Circuit is half-open and a trial call is already in progress');
      }
      halfOpenTrialInProgress = true;
    }

    const trialState = state;
    const outcome = await _capture(next, ctx);
    const isFailure = await shouldHandle(outcome);

    if (trialState === 'HalfOpen') {
      halfOpenTrialInProgress = false;
      if (isFailure) {
        await open(outcome);
      } else {
        await close();
      }
      return _unwrap(outcome);
    }

    // Closed state - record health and evaluate threshold
    const at = Date.now();
    prune(at);
    samples.push({ at, ok: !isFailure });

    if (samples.length >= minimumThroughput) {
      const failures = samples.reduce((acc, s) => acc + (s.ok ? 0 : 1), 0);
      if (failures / samples.length >= failureRatio) {
        await open(outcome);
      }
    }

    return _unwrap(outcome);
  };
}
