import assert from 'node:assert/strict';
import type { AuthenticationStrategy, AuthnContext, AuthnFailure, Credentials, StrategyOutcome } from '@spinajs/authn/contracts';
import type { FakeClock } from '../fakes/clock.js';
import type { EventsPort } from '../harness/ports.js';
import { assertSameTiming } from '../helpers/timing.js';
import type { TimedSource, TimingOptions } from '../helpers/timing.js';
import { PendingLog } from '../behaviour/runner.js';
import type { BddApi, TestThis } from '../behaviour/types.js';
import { bddOf, caseTimeout, pending, withSubject } from './run.js';

export interface StrategySubject {
  readonly strategy: AuthenticationStrategy;
  /** Fresh credentials the strategy accepts (a new jti/nonce each call where needed). */
  valid(): Promise<Credentials>;
  /** A known account with a wrong secret. */
  invalid(): Promise<Credentials>;
  /** An account that does not exist; omit for strategies without account lookup (OIDC). */
  unknown?(): Promise<Credentials>;
  /** Another credential with the same stable id as valid() (another assertion of the same key); non-interactive strategies. */
  sameId?(): Promise<Credentials>;
  /** Secret parts of c (password, token, JWS, signature) that must never appear in key values. */
  secretsOf(c: Credentials): readonly string[];
  /** Side-effect observers wired into the strategy's container. */
  readonly sessions: { count(): Promise<number> };
  readonly events: EventsPort;
  dispose?(): Promise<void>;
}

export type StrategySubjectFactory = (k: { clock: FakeClock }) => StrategySubject | Promise<StrategySubject>;

export interface StrategyConformanceOptions {
  /** Lanes should pass it: the strategy's name is unknown until the async factory runs, so the default title has none. */
  readonly title?: string;
  readonly timing?: TimingOptions | false;
  readonly fakeDate?: boolean;
  /** Timeout of the timing case (default 600 s); a lane with slower hashing raises it, e.g. with timingTimeoutMs. */
  readonly timeoutMs?: number;
  readonly bdd?: BddApi;
}

const FAILURES: readonly AuthnFailure[] = ['invalid_credentials', 'throttled', 'unsupported_credentials', 'expired', 'revoked', 'not_linked'];
const SECRET_MIN_LENGTH = 8;
const TIMING_CASE_TIMEOUT_MS = 600_000;

const purposeOf = (s: StrategySubject) => (s.strategy.interactive ? 'login' : 'request');

async function credentialsOf(s: StrategySubject): Promise<Credentials[]> {
  return [await s.valid(), await s.invalid(), ...(s.unknown ? [await s.unknown()] : [])];
}

export function runStrategyConformance(factory: StrategySubjectFactory, opts: StrategyConformanceOptions = {}): void {
  const bdd = bddOf(opts.bdd);
  const log = new PendingLog();
  const kase = (title: string, body: (s: StrategySubject, ctx: AuthnContext, t: TestThis) => Promise<void>, timeoutMs?: number) =>
    bdd.it(`conformance: ${title}`, async function (this: TestThis) {
      const deadline = caseTimeout(this, timeoutMs);
      await withSubject(factory, opts.fakeDate, (s, clock) => body(s, clock.ctx({ purpose: purposeOf(s) }), this), { timeoutMs: deadline, name: `conformance: ${title}` });
    });

  bdd.describe(opts.title ?? 'strategy conformance', () => {
    kase('name, kinds and interactive are declared', async ({ strategy }) => {
      assert.ok(typeof strategy.name === 'string' && strategy.name.length > 0, 'name');
      assert.ok(Array.isArray(strategy.kinds) && strategy.kinds.length > 0 && strategy.kinds.every((k) => typeof k === 'string' && k.length > 0), 'kinds');
      assert.strictEqual(typeof strategy.interactive, 'boolean');
    });

    kase('verify accepts valid credentials', async (s, ctx) => {
      const o = await s.strategy.verify(await s.valid(), ctx);
      assert.strictEqual(o.ok, true, `verify answered ${JSON.stringify(o)}`);
      if (o.ok) {
        assert.strictEqual(Number(o.identity !== undefined) + Number(o.external !== undefined), 1, 'exactly one of identity and external');
        assert.ok(typeof o.method === 'string' && o.method.length > 0, 'method');
      }
    });

    kase('verify answers invalid and unknown credentials alike without throwing', async (s, ctx) => {
      const oi: StrategyOutcome = await s.strategy.verify(await s.invalid(), ctx);
      assert.strictEqual(oi.ok, false);
      if (!oi.ok) {
        assert.deepStrictEqual(oi, { ok: false, reason: oi.reason });
        assert.ok(FAILURES.includes(oi.reason), `reason ${String(oi.reason)}`);
      }
      if (s.unknown) {
        assert.deepStrictEqual(await s.strategy.verify(await s.unknown(), ctx), oi);
      }
    });

    kase('an undeclared kind is unsupported_credentials', async (s, ctx) => {
      assert.deepStrictEqual(await s.strategy.verify({ kind: 'authn-testing-undeclared' }, ctx), { ok: false, reason: 'unsupported_credentials' });
    });

    kase('verify has no session or event side effects', async (s, ctx) => {
      const before = await s.sessions.count();
      await s.strategy.verify(await s.valid(), ctx);
      await s.strategy.verify(await s.invalid(), ctx);
      if (s.unknown) {
        await s.strategy.verify(await s.unknown(), ctx);
      }
      assert.strictEqual(await s.sessions.count(), before, 'sessions');
      assert.strictEqual(s.events.all().length, 0, 'events');
    });

    kase('throttle keys are stable', async (s, ctx) => {
      for (const c of await credentialsOf(s)) {
        assert.deepStrictEqual(s.strategy.throttleKeys(c, ctx), s.strategy.throttleKeys(c, ctx));
      }
    });

    kase('throttle key values carry no secret', async (s, ctx) => {
      for (const c of await credentialsOf(s)) {
        for (const key of s.strategy.throttleKeys(c, ctx)) {
          for (const secret of s.secretsOf(c).filter((x) => x.length >= SECRET_MIN_LENGTH)) {
            assert.ok(!key.value.includes(secret), `a ${key.kind} key value contains a credential secret`);
          }
        }
      }
    });

    kase('a non-interactive strategy returns account and account-ip keys from a stable id', async (s, ctx, t) => {
      if (s.strategy.interactive) {
        pending(t, 'n/a for interactive strategies', log);
      }
      const keys = s.strategy.throttleKeys(await s.valid(), ctx);
      const kinds = keys.map((k) => k.kind);
      assert.ok(kinds.includes('account') && kinds.includes('account-ip'), `key kinds ${JSON.stringify(kinds)}`);
      if (s.sameId) {
        assert.deepStrictEqual(s.strategy.throttleKeys(await s.sameId(), ctx), keys);
      }
    });

    kase(
      'A02 verify takes the same time for unknown accounts',
      async (s, ctx, t) => {
        const unknown = s.unknown?.bind(s);
        if (!unknown) {
          pending(t, 'n/a without unknown()', log);
        }
        if (opts.timing === false) {
          pending(t, 'timing off', log);
        }
        const source = (gen: () => Promise<Credentials>): TimedSource => ({
          prepare: async (count) => {
            const cs: Credentials[] = [];
            for (let i = 0; i < count; i++) {
              cs.push(await gen());
            }
            return cs.map((c) => () => s.strategy.verify(c, ctx));
          },
        });
        await assertSameTiming(
          source(() => s.invalid()),
          source(unknown),
          opts.timing || undefined,
        );
      },
      opts.timeoutMs ?? TIMING_CASE_TIMEOUT_MS,
    );
    log.register(bdd);
  });
}
