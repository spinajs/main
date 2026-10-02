import assert from 'node:assert/strict';
import 'mocha';
import type { Credentials, StrategyOutcome } from '@spinajs/authn/contracts';
import { runStrategyConformance } from '../src/conformance/index.js';
import type { StrategySubjectFactory } from '../src/conformance/index.js';
import { CASE, FAST_TIMING, bearerSubject, externalSubject, failedTitles, passwordSubject, pendingTitles, runSuite, wrap } from './reference/conformance-support.js';

const run = (factory: StrategySubjectFactory, opts: { timing?: typeof FAST_TIMING | false; fakeDate?: boolean } = {}) =>
  runSuite((bdd) => runStrategyConformance(factory, { bdd, timing: FAST_TIMING, ...opts }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isUnknownLogin = (c: Credentials) => c.kind === 'password' && c.login === 'conf-nobody';
const INVALID: StrategyOutcome = { ok: false, reason: 'invalid_credentials' };

describe('runStrategyConformance: reference strategies', function () {
  this.timeout(60_000);

  it('registers the nine cases in order', async () => {
    const r = await run(passwordSubject());
    assert.deepEqual(
      r.map((c) => c.title.split(' [pending')[0]),
      Object.values(CASE),
    );
  });

  it('FakeStrategy.password passes every case', async () => {
    const r = await run(passwordSubject());
    assert.deepEqual(failedTitles(r), []);
    assert.deepEqual(pendingTitles(r), [CASE.accountKeys + ' [pending: n/a for interactive strategies]']);
  });

  it('FakeStrategy.bearer passes every case, keys included', async () => {
    const r = await run(bearerSubject());
    assert.deepEqual(failedTitles(r), []);
    assert.deepEqual(pendingTitles(r), []);
  });

  it('FakeStrategy.external passes; timing and keys are pending, never silent', async () => {
    const r = await run(externalSubject());
    assert.deepEqual(failedTitles(r), []);
    assert.deepEqual(pendingTitles(r), [CASE.accountKeys + ' [pending: n/a for interactive strategies]', CASE.timing + ' [pending: n/a without unknown()]']);
  });

  it('timing: false makes the timing case pending', async () => {
    const r = await run(passwordSubject(), { timing: false });
    assert.ok(pendingTitles(r).includes(CASE.timing + ' [pending: timing off]'));
  });

  it('installs the clock by default and leaves Date alone with fakeDate: false', async () => {
    let seen: number[] = [];
    const factory = passwordSubject((s) =>
      wrap(s, {
        verify: async (c, ctx) => {
          seen.push(Date.now() - ctx.now.getTime());
          return s.verify(c, ctx);
        },
      }),
    );
    await run(factory, { timing: false });
    assert.ok(seen.length > 0 && seen.every((d) => d === 0), 'Date follows ctx.now by default');
    seen = [];
    await run(factory, { timing: false, fakeDate: false });
    assert.ok(
      seen.some((d) => d !== 0),
      'Date is real with fakeDate: false',
    );
  });

  it('disposes the subject once per case and uninstalls the clock', async () => {
    let disposed = 0;
    const base = passwordSubject();
    const r = await run(async (k) => ({ ...(await base(k)), dispose: async () => void disposed++ }), { timing: false });
    assert.equal(disposed, r.length);
    assert.ok(Date.now() > 1_600_000_000_000 && new Date().getFullYear() >= 2026);
  });
});

describe('runStrategyConformance: broken strategies fail the named case', function () {
  this.timeout(60_000);

  const expectFails = async (factory: StrategySubjectFactory, ...titles: string[]) => {
    const r = await run(factory);
    assert.deepEqual(failedTitles(r), titles);
  };

  it('a secret in a throttle key value', () =>
    expectFails(
      passwordSubject((s) => wrap(s, { throttleKeys: (c, ctx) => (c.kind === 'password' ? [{ kind: 'account', value: String(c.password) }, ...s.throttleKeys(c, ctx)] : []) })),
      CASE.noSecret,
    ));

  it('a secret in the keys of a non-interactive strategy', () =>
    expectFails(
      bearerSubject((s) => wrap(s, { throttleKeys: (c) => [{ kind: 'account', value: String((c as { token: string }).token) }, { kind: 'account-ip', value: `${String((c as { token: string }).token)}|ip` }] })),
      CASE.noSecret,
    ));

  it('a timing leak: unknown accounts answer after a sleep', () =>
    expectFails(
      passwordSubject((s) =>
        wrap(s, {
          verify: async (c, ctx) => {
            if (isUnknownLogin(c)) {
              await sleep(5);
            }
            return s.verify(c, ctx);
          },
        }),
      ),
      CASE.timing,
    ));

  it('throws on another kind', () =>
    expectFails(
      passwordSubject((s) =>
        wrap(s, {
          verify: async (c, ctx) => {
            if (c.kind !== 'password') {
              throw new Error('unexpected kind');
            }
            return s.verify(c, ctx);
          },
        }),
      ),
      CASE.undeclared,
    ));

  it('answers another kind with invalid_credentials', () =>
    expectFails(
      passwordSubject((s) => wrap(s, { verify: async (c, ctx) => (c.kind === 'password' ? s.verify(c, ctx) : INVALID) })),
      CASE.undeclared,
    ));

  it('publishes an event from verify', () =>
    expectFails(
      passwordSubject((s, env) =>
        wrap(s, {
          verify: async (c, ctx) => {
            await env.events.publish({ type: 'login', outcome: 'success', at: ctx.now } as never);
            return s.verify(c, ctx);
          },
        }),
      ),
      CASE.sideEffects,
    ));

  it('issues a session from verify', () =>
    expectFails(
      passwordSubject((s, env) =>
        wrap(s, {
          verify: async (c, ctx) => {
            const o = await s.verify(c, ctx);
            if (o.ok) {
              env.sessions.n++;
            }
            return o;
          },
        }),
      ),
      CASE.sideEffects,
    ));

  it('unstable keys', () => {
    let n = 0;
    return expectFails(
      passwordSubject((s) => wrap(s, { throttleKeys: (c, ctx) => s.throttleKeys(c, ctx).map((k) => ({ ...k, value: `${k.value}#${n++}` })) })),
      CASE.stable,
    );
  });

  it('unknown accounts answer with another reason', () =>
    expectFails(
      passwordSubject((s) => wrap(s, { verify: async (c, ctx) => (isUnknownLogin(c) ? { ok: false, reason: 'not_linked' } : s.verify(c, ctx)) })),
      CASE.alike,
    ));

  it('a failure outcome with extra fields', () =>
    expectFails(
      passwordSubject((s) =>
        wrap(s, {
          verify: async (c, ctx): Promise<StrategyOutcome> => {
            const o = await s.verify(c, ctx);
            return o.ok || c.kind !== 'password' ? o : ({ ...o, detail: 'no such account' } as StrategyOutcome);
          },
        }),
      ),
      CASE.alike,
    ));

  it('rejects valid credentials', () => expectFails(passwordSubject((s) => wrap(s, { verify: async (c, ctx) => (c.kind === 'password' ? INVALID : s.verify(c, ctx)) })), CASE.accepts));

  it('answers success with neither identity nor external', () =>
    expectFails(
      passwordSubject((s) => wrap(s, { verify: async (c, ctx) => ((o) => (o.ok ? { ok: true, method: 'password' } : o))(await s.verify(c, ctx)) })),
      CASE.accepts,
    ));

  it('declares no kinds', () => expectFails(passwordSubject((s) => wrap(s, { kinds: [] })), CASE.declared));

  it('a non-interactive strategy without an account-ip key', () =>
    expectFails(
      bearerSubject((s) => wrap(s, { throttleKeys: (c, ctx) => s.throttleKeys(c, ctx).filter((k) => k.kind === 'account') })),
      CASE.accountKeys,
    ));

  it('a non-interactive strategy whose keys differ for the same id', () => {
    const ids = new WeakMap<object, number>();
    let next = 0;
    return expectFails(
      bearerSubject((s) =>
        wrap(s, {
          throttleKeys: (c, ctx) => {
            if (!ids.has(c)) {
              ids.set(c, next++);
            }
            return s.throttleKeys(c, ctx).map((k) => ({ ...k, value: `${k.value}#${ids.get(c)}` }));
          },
        }),
      ),
      CASE.accountKeys,
    );
  });
});
