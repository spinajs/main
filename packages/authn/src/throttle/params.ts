import type { ThrottleParams } from '../contracts/throttle.js';

/** `authn.throttle` as the schema delivers it: the limits, plus the service name and the row cap. */
export type ThrottleConfig = ThrottleParams & { readonly service?: string; readonly maxRows?: number };

// Same values as the schema defaults (test/boot/config-defaults.test.ts); the fallback of explicit params.
export const DEFAULT_THROTTLE_MAX_ROWS = 1_000_000;
