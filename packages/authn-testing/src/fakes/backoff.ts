import { AuthnThrottle } from '@spinajs/authn/contracts';
import type { AuthnContext, ThrottleFlow, ThrottleKey } from '@spinajs/authn/contracts';
import type { BackoffParams, ThrottleParams } from '../harness/ports.js';

/** One throttle key's bookkeeping. */
export interface BackoffRow {
  attempts: number;
  lastMs: number;
  nextMs: number;
}

/**
 * Backoff per key, never a lock: after `free` counted attempts each key waits min(base × 2^(n − free), max);
 * refused attempts count nothing; account-ip only keeps bookkeeping; a success resets the account key and takes
 * that account's attempts off the ip key ('reset' clears nothing); a key idle for resetAfterSeconds starts over.
 * In memory and synchronous inside one await, so bursts are atomic. `peek` refuses as `attempt` would and counts
 * nothing (K5). A fake for lanes before N1's MemoryAuthnThrottle.
 */
export class FakeBackoffThrottle extends AuthnThrottle {
  protected readonly rows = new Map<string, BackoffRow>();

  constructor(protected readonly params: ThrottleParams) {
    super();
  }

  protected delayMs(p: BackoffParams, n: number): number {
    return n < p.free ? 0 : Math.min(p.baseDelayMs * 2 ** (n - p.free), p.maxDelayMs);
  }

  /** Called for each gating row of a refused attempt; the correct throttle does nothing. */
  protected onRefused(_row: BackoffRow, _p: BackoffParams, _nowMs: number): void {}

  private gating(keys: readonly ThrottleKey[], flow: ThrottleFlow): { id: string; p: BackoffParams }[] {
    const f = this.params[flow];
    const out: { id: string; p: BackoffParams }[] = [];
    for (const k of keys) {
      const p = k.kind === 'account' ? f.account : k.kind === 'ip' ? f.ip : k.kind === 'global' ? this.params.global : undefined;
      if (p) {
        out.push({ id: `${flow}|${k.kind}|${k.value}`, p });
      }
    }
    return out;
  }

  private live(id: string, nowMs: number): BackoffRow | undefined {
    const row = this.rows.get(id);
    if (row && nowMs - row.lastMs >= this.params.resetAfterSeconds * 1000) {
      this.rows.delete(id);
      return undefined;
    }
    return row;
  }

  private waitMs(gates: readonly { id: string }[], nowMs: number): number {
    let waitMs = 0;
    for (const g of gates) {
      const row = this.live(g.id, nowMs);
      if (row && row.nextMs > nowMs) {
        waitMs = Math.max(waitMs, row.nextMs - nowMs);
      }
    }
    return waitMs;
  }

  async peek(keys: readonly ThrottleKey[], flow: ThrottleFlow, ctx: AuthnContext): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
    const waitMs = this.waitMs(this.gating(keys, flow), ctx.now.getTime());
    return waitMs > 0 ? { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) } : { allowed: true };
  }

  async attempt(keys: readonly ThrottleKey[], flow: ThrottleFlow, ctx: AuthnContext): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
    const nowMs = ctx.now.getTime();
    const gates = this.gating(keys, flow);
    const waitMs = this.waitMs(gates, nowMs);
    if (waitMs > 0) {
      for (const g of gates) {
        const row = this.rows.get(g.id);
        if (row) {
          this.onRefused(row, g.p, nowMs);
        }
      }
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
    }
    for (const g of gates) {
      const row = this.live(g.id, nowMs) ?? { attempts: 0, lastMs: nowMs, nextMs: 0 };
      row.attempts += 1;
      row.lastMs = nowMs;
      row.nextMs = this.delayMs(g.p, row.attempts) > 0 ? nowMs + this.delayMs(g.p, row.attempts) : 0;
      this.rows.set(g.id, row);
    }
    for (const k of keys) {
      if (k.kind === 'account-ip') {
        const id = `${flow}|account-ip|${k.value}`;
        const row = this.live(id, nowMs) ?? { attempts: 0, lastMs: nowMs, nextMs: 0 };
        row.attempts += 1;
        row.lastMs = nowMs;
        this.rows.set(id, row);
      }
    }
    return { allowed: true };
  }

  async succeed(keys: readonly ThrottleKey[], flow: ThrottleFlow): Promise<void> {
    if (flow === 'reset') {
      return;
    }
    const f = this.params[flow];
    let spent = 0;
    for (const k of keys) {
      if (k.kind === 'account-ip') {
        const id = `${flow}|account-ip|${k.value}`;
        spent += this.rows.get(id)?.attempts ?? 0;
        this.rows.delete(id);
      }
    }
    for (const k of keys) {
      if (k.kind === 'account') {
        this.rows.delete(`${flow}|account|${k.value}`);
      } else if (k.kind === 'ip' && f.ip) {
        const row = this.rows.get(`${flow}|ip|${k.value}`);
        if (row) {
          row.attempts = Math.max(0, row.attempts - spent);
          const d = this.delayMs(f.ip, row.attempts);
          row.nextMs = d > 0 ? row.lastMs + d : 0;
        }
      }
    }
  }
}
