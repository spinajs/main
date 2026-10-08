import { MemoryAuthnThrottle } from '../../src/index.js';
import type { BackoffParams, ThrottleFlow, ThrottleKey } from '../../src/index.js';

/** 2.x shape (SR-05): a fixed 15 minute lock after the free attempts, past any maxDelayMs. */
export class Lockout extends MemoryAuthnThrottle {
  protected delayMs(p: BackoffParams, n: number): number {
    return n < p.free ? 0 : 15 * 60_000;
  }
}

/** Breaks D8: a success drops the whole ip row, other accounts' failures with it. */
export class SuccessClearsIp extends MemoryAuthnThrottle {
  async succeed(keys: readonly ThrottleKey[], flow: ThrottleFlow): Promise<void> {
    await super.succeed(keys, flow);
    for (const k of keys) if (k.kind === 'ip') this.tables[flow].rows.delete(this.keyId(flow, k));
  }
}
