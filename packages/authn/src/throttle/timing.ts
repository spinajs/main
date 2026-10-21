import { Perf } from '@spinajs/log-common';

/** Awaits one throttle round trip and records how long it took, in ms. */
export async function timedThrottle<T>(call: () => Promise<T>): Promise<T> {
  if (!Perf.Enabled) return call();
  const t0 = performance.now();
  try {
    return await call();
  } finally {
    Perf.value('authn.throttle.db', performance.now() - t0);
  }
}
