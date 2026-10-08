import assert from 'node:assert/strict';
import 'mocha';
import type { AuthenticationResult, AuthnContext, AuthnThrottle, Credentials, IdentityStatus, SessionHandle, ThrottleFlow, ThrottleKey } from '@spinajs/authn/contracts';
import { AUTHN_RULES, planCases, settleCase } from '../src/behaviour/index.js';
import type { HarnessFactory, PlannedCase } from '../src/behaviour/index.js';
import { MemorySessionIssuer } from '../src/fakes/index.js';
import type { FakeIdentityStore, FakeStrategy, MemorySessionOptions } from '../src/fakes/index.js';
import type { ThrottleParams } from '../src/harness/index.js';
import { sha256hex } from '../src/helpers/index.js';
import { fakeStoreHarness, referenceHarness, throttleHarness } from './reference/harness.js';
import { ReferenceAuthnService } from './reference/service.js';
import { ReferenceBackoffThrottle } from './reference/throttle.js';
import type { BackoffParams } from '../src/harness/index.js';

const byName = (name: string): PlannedCase => {
  const hits = [...AUTHN_RULES.keys()].flatMap((id) => planCases([id])).filter((p) => p.kase.name === name || p.kase.name.startsWith(name));
  assert.strictEqual(hits.length, 1, `exactly one case named ${name}`);
  return hits[0];
};

/** The case passes on the good harness and fails on the mutant. */
async function bites(name: string, good: HarnessFactory, mutant: HarnessFactory): Promise<void> {
  const p = byName(name);
  const g = await settleCase(p, good);
  assert.strictEqual(g.status, 'passed', `${name} on the reference: ${String(g.error)}`);
  const m = await settleCase(p, mutant);
  assert.strictEqual(m.status, 'failed', `${name} on the mutant`);
}

// Service mutants (A02, A05)

/** M02a: the password strategy reports unknown accounts as not_linked. */
const unknownIsNotLinked = (s: FakeStrategy, identities: FakeIdentityStore) =>
  Object.assign(Object.create(s), {
    async verify(c: Credentials, ctx: AuthnContext) {
      const r = await s.verify(c, ctx);
      return !r.ok && (await identities.findByLogin(String((c as { login?: string }).login))) === null ? { ok: false, reason: 'not_linked' } : r;
    },
  });

/** M02b */
class NoRetryAfter extends ReferenceAuthnService {
  async authenticate(c: Credentials, ctx: AuthnContext): Promise<AuthenticationResult> {
    const r = await super.authenticate(c, ctx);
    return r.status === 'failure' ? { status: 'failure', reason: r.reason } : r;
  }
}

/** M02c */
class OneAuditReason extends ReferenceAuthnService {
  protected statusReason(st: IdentityStatus): string | null {
    return super.statusReason(st) === null ? null : 'inactive';
  }
}

/** M05a: check the slot, verify, then count. */
class CountAfterVerify extends ReferenceAuthnService {
  protected countBeforeVerify = false;
}

// Throttle mutants (A05, A06)

/** M05b: reads the rows, awaits, then writes from the stale read. */
class NonAtomic extends ReferenceBackoffThrottle {
  async attempt(keys: readonly ThrottleKey[], flow: ThrottleFlow, ctx: AuthnContext) {
    const read = new Map([...this.rows].map(([k, r]) => [k, { ...r }]));
    await new Promise((r) => setImmediate(r));
    this.rows.clear();
    read.forEach((r, k) => this.rows.set(k, r));
    return super.attempt(keys, flow, ctx);
  }
}

/** M05c */
class CountsRefused extends ReferenceBackoffThrottle {
  protected onRefused(row: { attempts: number; lastMs: number; nextMs: number }, p: BackoffParams, nowMs: number): void {
    row.attempts += 1;
    row.lastMs = nowMs;
    row.nextMs = nowMs + this.delayMs(p, row.attempts);
  }
}

/** M06a */
class OffByOne extends ReferenceBackoffThrottle {
  protected delayMs(p: BackoffParams, n: number): number {
    return n < p.free ? 0 : Math.min(p.baseDelayMs * 2 ** (n - p.free + 1), p.maxDelayMs);
  }
}

/** M06b */
class NoCap extends ReferenceBackoffThrottle {
  protected delayMs(p: BackoffParams, n: number): number {
    return n < p.free ? 0 : p.baseDelayMs * 2 ** (n - p.free);
  }
}

/** M06c */
class SuccessClearsIp extends ReferenceBackoffThrottle {
  async succeed(keys: readonly ThrottleKey[], flow: ThrottleFlow): Promise<void> {
    await super.succeed(keys, flow);
    keys.filter((k) => k.kind === 'ip').forEach((k) => this.rows.delete(`${flow}|ip|${k.value}`));
  }
}

/** M05e: failures are never counted. */
class CountsNothing extends ReferenceBackoffThrottle {
  async attempt(): Promise<{ allowed: true }> {
    return { allowed: true };
  }
}

/** M06d */
class NoIdleReset extends ReferenceBackoffThrottle {
  constructor(params: ThrottleParams) {
    super({ ...params, resetAfterSeconds: Number.POSITIVE_INFINITY });
  }
}

/** M06e: account-ip gates like an account key. */
class AccountIpGates extends ReferenceBackoffThrottle {
  async attempt(keys: readonly ThrottleKey[], flow: ThrottleFlow, ctx: AuthnContext) {
    return super.attempt(
      keys.map((k) => (k.kind === 'account-ip' ? { kind: 'account', value: `aip|${k.value}` } : k)),
      flow,
      ctx,
    );
  }
}

// Session issuer mutants (A07)

/** M07a: a raw copy of every id lands in storage. */
class StoresRawId extends MemorySessionIssuer {
  private readonly raw: string[] = [];
  constructor(o: MemorySessionOptions) {
    super(o);
    const keys = this.storage.storedKeys.bind(this.storage);
    (this.storage as { storedKeys: () => Promise<readonly string[]> }).storedKeys = async () => [...(await keys()), ...this.raw];
  }
  async issue(...a: Parameters<MemorySessionIssuer['issue']>): Promise<SessionHandle> {
    const h = await super.issue(...a);
    this.raw.push(h.id);
    return h;
  }
}

/** M07b: restore also accepts the stored hash. */
class AcceptsHash extends MemorySessionIssuer {
  private readonly byHash = new Map<string, string>();
  async issue(...a: Parameters<MemorySessionIssuer['issue']>): Promise<SessionHandle> {
    const h = await super.issue(...a);
    this.byHash.set(sha256hex(h.id), h.id);
    return h;
  }
  async restore(raw: string) {
    return (await super.restore(raw)) ?? (this.byHash.has(raw) ? super.restore(this.byHash.get(raw)!) : null);
  }
}

/** M07c: rotate copies the session and leaves the old id alive. */
class RotateKeepsOld extends MemorySessionIssuer {
  async rotate(h: SessionHandle): Promise<SessionHandle> {
    const r = (await this.restore(h.id))!;
    const next = await this.issue(r.identity, r.facts);
    for (const [k, v] of r.data) await this.set(next, k, v);
    return next;
  }
}

/** M07d: no raw fallback for 2.x ids. */
class NoLegacyMigration extends MemorySessionIssuer {
  async restore(raw: string) {
    return /^[0-9a-f]{8}-/.test(raw) ? null : super.restore(raw);
  }
}

const withService =
  (S: typeof ReferenceAuthnService): HarnessFactory =>
  (ctx) =>
    referenceHarness(ctx, undefined, { service: (d) => new S(d) });
const withThrottle =
  (make: (p: ThrottleParams) => AuthnThrottle): HarnessFactory =>
  (ctx) =>
    throttleHarness(ctx, make);
/** The reference service over a throttle mutant (K5 cases). */
const withFlowThrottle =
  (make: (p: ThrottleParams) => AuthnThrottle): HarnessFactory =>
  (ctx) =>
    referenceHarness(ctx, undefined, { throttle: make });
const withIssuer =
  (make: (o: MemorySessionOptions) => MemorySessionIssuer): HarnessFactory =>
  (ctx) =>
    fakeStoreHarness(ctx, make);
const reference: HarnessFactory = (ctx) => referenceHarness(ctx);
const throttle: HarnessFactory = (ctx) => throttleHarness(ctx);
const issuer: HarnessFactory = (ctx) => fakeStoreHarness(ctx);

describe('mutation checks (design §10.4)', function () {
  this.timeout(120_000);

  it('M02a unknown account answers not_linked', () => bites('A02 failures answer alike: unknown account', reference, (ctx) => referenceHarness(ctx, undefined, { password: unknownIsNotLinked })));
  it('M02b throttled failure without retryAfterSeconds', () => bites('A02 a throttled answer carries the same Retry-After', reference, withService(NoRetryAfter)));
  it('M02c status failures audited with one reason', () => bites('A02 banned, inactive and deleted keep distinct reasons in audit', reference, withService(OneAuditReason)));
  it('M05a count after verify', () => bites('A05 a parallel burst of logins verifies only free attempts', reference, withService(CountAfterVerify)));
  it('M05b non-atomic throttle', () =>
    bites(
      'A05 SR-05 parallel burst verifies only free attempts',
      throttle,
      withThrottle((p) => new NonAtomic(p)),
    ));
  it('M05c refused attempts counted', () =>
    bites(
      'A05 a refused attempt is neither counted nor delays later slots',
      throttle,
      withThrottle((p) => new CountsRefused(p)),
    ));
  it('M06a exponent n − free + 1', () =>
    bites(
      'A06 the login account key follows the backoff schedule',
      throttle,
      withThrottle((p) => new OffByOne(p)),
    ));
  it('M06b no cap', async () => {
    await bites(
      'A06 the login account key follows the backoff schedule',
      throttle,
      withThrottle((p) => new NoCap(p)),
    );
    await bites(
      'A06 SR-05 attacker cannot lock the owner out',
      throttle,
      withThrottle((p) => new NoCap(p)),
    );
  });
  it('M06c success clears the whole IP key', () =>
    bites(
      "A06 a success on an own account leaves other accounts' failures on the ip key",
      throttle,
      withThrottle((p) => new SuccessClearsIp(p)),
    ));
  it('M05d per-request calls count before verify (no peek)', () =>
    bites(
      'A05 parallel per-request calls with a valid credential all verify',
      reference,
      withFlowThrottle((p) => Object.assign(new ReferenceBackoffThrottle(p), { peek: undefined })),
    ));
  it('M05e per-request failures not counted', () =>
    bites(
      'A05 per-request failures are counted and back off',
      reference,
      withFlowThrottle((p) => new CountsNothing(p)),
    ));
  it('M06f a per-request success clears the whole IP key', () =>
    bites(
      "A06 a per-request success leaves other credentials' failures on the ip key",
      reference,
      withFlowThrottle((p) => new SuccessClearsIp(p)),
    ));
  it('M06d no idle reset', () =>
    bites(
      'A06 a key idle for resetAfterSeconds starts from zero',
      throttle,
      withThrottle((p) => new NoIdleReset(p)),
    ));
  it('M06e account-ip gates', () =>
    bites(
      'A06 account-ip gates nothing',
      throttle,
      withThrottle((p) => new AccountIpGates(p)),
    ));
  it('M07a issuer stores the raw id', () =>
    bites(
      'A07 stores keep only a hash of the id',
      issuer,
      withIssuer((o) => new StoresRawId(o)),
    ));
  it('M07b restore accepts the stored hash', () =>
    bites(
      'A07 SR-18 a stored hash never works as an id',
      issuer,
      withIssuer((o) => new AcceptsHash(o)),
    ));
  it('M07c rotate keeps the old id alive', () =>
    bites(
      'A07 rotate gives a new id, keeps the data and kills the old id',
      issuer,
      withIssuer((o) => new RotateKeepsOld(o)),
    ));
  it('M07d legacy restore without migration', () =>
    bites(
      'A07 a 2.x raw id is migrated on first use',
      issuer,
      withIssuer((o) => new NoLegacyMigration(o)),
    ));
});
