import type { ThrottleParams } from '../contracts/throttle.js';

/** `authn.throttle.memory`: how a `MemoryAuthnThrottle` sweeps and fills its tables. */
export interface MemoryThrottleConfig {
  readonly sweepBatch: number;
  readonly fullRetrySeconds: number;
  readonly holdOffMs: number;
}

/** `authn.throttle` as the schema delivers it: the limits, plus the service name, the row cap and the memory tuning. */
export type ThrottleConfig = ThrottleParams & { readonly service?: string; readonly maxRows?: number; readonly memory?: MemoryThrottleConfig };

// Same values as the schema defaults (test/boot/config-defaults.test.ts); the fallback of explicit params.
export const DEFAULT_THROTTLE_MAX_ROWS = 1_000_000;
export const DEFAULT_MEMORY_THROTTLE: MemoryThrottleConfig = Object.freeze({ sweepBatch: 8, fullRetrySeconds: 60, holdOffMs: 1000 });
