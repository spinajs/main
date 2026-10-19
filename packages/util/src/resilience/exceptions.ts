import { Exception } from '@spinajs/exceptions';

/**
 * Thrown when an operation is canceled via its {@link AbortSignal}
 * eg. when an outer timeout strategy aborts an inner retry delay.
 */
export class CanceledException extends Exception {}

/**
 * Thrown by the timeout strategy when the guarded operation does not
 * complete within the configured time.
 */
export class TimeoutRejectedException extends Exception {}

/**
 * Thrown by the circuit breaker strategy while the circuit is open
 * ( eg. too many failures occured and the breaker rejects calls fast ).
 */
export class BrokenCircuitException extends Exception {}

/**
 * Thrown by the circuit breaker when it was manually isolated.
 * Calls are rejected until the circuit is reset.
 */
export class IsolatedCircuitException extends BrokenCircuitException {}

/**
 * Thrown by the rate / concurrency limiter strategy when no permit is
 * available and the queue ( if any ) is full.
 */
export class RateLimiterRejectedException extends Exception {}

/**
 * Thrown by the hedging strategy when it ends without any outcome to surface.
 * When every attempt is handled, hedging rethrows the last error or returns the last
 * handled result instead, so in practice this is not reached.
 */
export class HedgingException extends Exception {}
