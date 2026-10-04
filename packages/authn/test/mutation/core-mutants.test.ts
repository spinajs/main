import assert from 'node:assert/strict';
import 'mocha';
import { AUTHN_RULES, planCases, settleCase, throttleParams } from '@spinajs/authn-testing';
import type { HarnessFactory, PlannedCase } from '@spinajs/authn-testing';

import { AuthnImpersonationService, DefaultAuthnService, MemoryAuthnThrottle } from '../../src/index.js';
import type { AuthenticationResult, AuthnContext, AuthnThrottle, Credentials, IdentityRef, IdentityStatus, IdentityStore, Principal, SessionHandle, StrategyRegistry, ThrottleParams } from '../../src/index.js';
import { buildCore, coreHarness, coreHarnessOf, useHarnessLog } from '../behaviour/harness.js';
import { Lockout, SuccessClearsIp } from './throttle-mutants.js';

// The mutants reach private members by casting: TypeScript's private is compile-time only.

/** 2.x order (A05): verify first, count only what failed. */
class VerifyBeforeCount extends DefaultAuthnService {
  async authenticate(c: Credentials, ctx: AuthnContext): Promise<AuthenticationResult> {
    const { registry, throttle } = this as unknown as { registry: StrategyRegistry; throttle: AuthnThrottle };
    const s = registry.candidates(c)[0];
    if (!s) return super.authenticate(c, ctx);
    const outcome = await s.verify(c, ctx);
    if (outcome.ok) return super.authenticate(c, ctx);
    const gate = await throttle.attempt([...s.throttleKeys(c, ctx), ...(ctx.ip ? [{ kind: 'ip', value: ctx.ip }] : [])], 'login', ctx);
    return gate.allowed ? { status: 'failure', reason: 'invalid_credentials' } : { status: 'failure', reason: 'throttled', retryAfterSeconds: gate.retryAfterSeconds };
  }
}

/** 2.x shape (SR-06): only the target's status ends an impersonation; the impersonator's ban is not seen. */
class IgnoresImpersonatorBan extends AuthnImpersonationService {
  async principalOf(session: SessionHandle, ctx: AuthnContext): Promise<Principal | null> {
    const self = this as unknown as { sessions: { restore(id: string): Promise<{ facts: { impersonator?: IdentityRef } } | null> }; identities: IdentityStore };
    const actor = (await self.sessions.restore(session.id))?.facts.impersonator;
    if (!actor) return super.principalOf(session, ctx);
    const real = self.identities;
    self.identities = Object.assign(Object.create(real) as IdentityStore, {
      async status(id: IdentityRef): Promise<IdentityStatus> {
        const st = await real.status(id);
        return id.type === actor.type && id.id === actor.id ? { ...st, banned: false } : st;
      },
    });
    try {
      return await super.principalOf(session, ctx);
    } finally {
      self.identities = real;
    }
  }
}

const byName = (name: string): PlannedCase => {
  const hits = [...AUTHN_RULES.keys()].flatMap((id) => planCases([id])).filter((p) => p.kase.name === name);
  assert.strictEqual(hits.length, 1, `exactly one kit case named ${name}`);
  return hits[0];
};

/** The kit case passes on the real code and fails on the mutant. */
async function bites(name: string, good: HarnessFactory, mutant: HarnessFactory): Promise<void> {
  const p = byName(name);
  const g = await settleCase(p, good);
  assert.strictEqual(g.status, 'passed', `${name} on the real code: ${String(g.error)}`);
  const m = await settleCase(p, mutant);
  assert.strictEqual(m.status, 'failed', `${name} on the mutant`);
  // A crash in the mutant's harness would also fail the case; only a failed assertion counts.
  assert.ok(m.error instanceof assert.AssertionError, `${name} on the mutant: ${String(m.error)}`);
}

const withService =
  (S: typeof DefaultAuthnService): HarnessFactory =>
  async (ctx) => {
    const parts = await buildCore(ctx.config);
    try {
      return coreHarnessOf({ ...parts, service: await parts.child.resolve(S) });
    } catch (e) {
      await parts.dispose();
      throw e;
    }
  };

const withImpersonation =
  (S: typeof AuthnImpersonationService): HarnessFactory =>
  async (ctx) => {
    const parts = await buildCore(ctx.config);
    try {
      const m = await parts.child.resolve(S);
      return {
        ...coreHarnessOf(parts),
        impersonation: {
          start: (session, target, c, reauth) => m.start(session, target, c, reauth),
          stop: (session, c) => m.stop(session, c),
          principalOf: (session, c) => m.principalOf(session, c),
        },
      };
    } catch (e) {
      await parts.dispose();
      throw e;
    }
  };

const withThrottle =
  (make: (p: ThrottleParams) => AuthnThrottle): HarnessFactory =>
  (ctx) => {
    const params = throttleParams(ctx.config);
    return { throttle: { throttle: make(params), params } };
  };

const throttle = withThrottle((p) => new MemoryAuthnThrottle(p));

describe('N1 mutation checks', function () {
  this.timeout(600_000);
  useHarnessLog();

  it('a service that verifies before counting fails the A05 burst case', () => bites('A05 a parallel burst of logins verifies only free attempts', coreHarness, withService(VerifyBeforeCount)));

  it('a locking throttle fails the A06 owner case', () =>
    bites(
      'A06 SR-05 attacker cannot lock the owner out',
      throttle,
      withThrottle((p) => new Lockout(p)),
    ));

  it('a success that clears the whole ip key fails the D8 case', () =>
    bites(
      "A06 a success on an own account leaves other accounts' failures on the ip key",
      throttle,
      withThrottle((p) => new SuccessClearsIp(p)),
    ));

  it('an impersonation that ignores the impersonator ban fails SR-06', () => bites('A20 SR-06 banning the impersonator ends the impersonation', coreHarness, withImpersonation(IgnoresImpersonatorBan)));
});
