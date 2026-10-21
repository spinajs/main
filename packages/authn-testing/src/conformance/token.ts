import assert from 'node:assert/strict';
import type { IdentityRef, TokenCreateOptions, TokenCreateResult, TokenRotateResult, TokenService } from '@spinajs/authn/contracts';
import type { FakeClock } from '../fakes/clock.js';
import { conformanceSuite } from './run.js';
import type { ConformanceOptions } from './run.js';

export interface TokenServiceUnderTest {
  readonly service: TokenService;
  /** Identities the service accepts as token owners; each call returns a new one. */
  readonly owners: { make(): Promise<IdentityRef> };
  dispose?(): Promise<void>;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type Created = Extract<TokenCreateResult, { ok: true }>;
type Rotated = Extract<TokenRotateResult, { ok: true }>;

async function mint(t: TokenServiceUnderTest, clock: FakeClock, owner: IdentityRef, name: string, over: Partial<TokenCreateOptions> = {}): Promise<Created> {
  const opts = { name, kind: 'pat', expiresAt: new Date(clock.now().getTime() + HOUR), ...over } as TokenCreateOptions;
  const result = await t.service.create(owner, opts, clock.ctx({ purpose: 'request' }));
  assert.ok(result.ok, 'create refused: ' + (result.ok ? '' : result.code));
  return result;
}

async function rotate(t: TokenServiceUnderTest, clock: FakeClock, owner: IdentityRef, id: string, opts?: { readonly graceSeconds?: number }): Promise<Rotated> {
  const result = await t.service.rotate(owner, id, clock.ctx({ purpose: 'request' }), opts);
  assert.ok(result.ok, 'rotate refused: ' + (result.ok ? '' : result.reason));
  return result;
}

const agentOptions = (clock: FakeClock): Partial<TokenCreateOptions> => ({ kind: 'agent', expiresAt: new Date(clock.now().getTime() + 5 * MINUTE), scope: { agent: true, permissions: ['conf:read'] } });

/** Each case gets a service from `make` over an empty token store, and a fake clock that also moves `ctx.now`. */
export function runTokenServiceConformance(name: string, make: () => Promise<TokenServiceUnderTest>, opts: ConformanceOptions = {}): void {
  conformanceSuite(name, make, opts, true, (kase) => {
    kase('create returns the plaintext once, and list never holds it', async (t, clock) => {
      const owner = await t.owners.make();
      const created = await mint(t, clock, owner, 'laptop');
      assert.ok(created.plaintext.length >= 32, 'a token is long enough to be unguessable');
      assert.deepStrictEqual(created.record.owner, owner);
      assert.strictEqual(created.record.name, 'laptop');
      assert.strictEqual(created.record.kind, 'pat');
      assert.ok(!JSON.stringify(created.record).includes(created.plaintext), 'the record holds the plaintext');

      const listed = await t.service.list(owner);
      assert.deepStrictEqual(listed.map((r) => r.id), [created.record.id]);
      assert.ok(!JSON.stringify(listed).includes(created.plaintext), 'the list holds the plaintext');
    });

    kase('two tokens never share a plaintext or an id', async (t, clock) => {
      const owner = await t.owners.make();
      const a = await mint(t, clock, owner, 'a');
      const b = await mint(t, clock, owner, 'b');
      assert.notStrictEqual(a.plaintext, b.plaintext);
      assert.notStrictEqual(a.record.id, b.record.id);
    });

    kase('validate accepts the plaintext and names the owner and the token', async (t, clock) => {
      const owner = await t.owners.make();
      const created = await mint(t, clock, owner, 'laptop');
      const result = await t.service.validate(created.plaintext, clock.ctx({ purpose: 'request' }));
      assert.ok(result.ok);
      assert.deepStrictEqual(result.identity, owner);
      assert.strictEqual(result.method, 'token');
      assert.strictEqual(result.token.id, created.record.id);
    });

    kase('validate fails with invalid_credentials for an unknown token', async (t, clock) => {
      const owner = await t.owners.make();
      const created = await mint(t, clock, owner, 'laptop');
      const ctx = clock.ctx({ purpose: 'request' });
      for (const raw of ['conf-token-never-issued', created.plaintext + 'x', created.plaintext.slice(1), '']) {
        assert.deepStrictEqual(await t.service.validate(raw, ctx), { ok: false, reason: 'invalid_credentials' }, JSON.stringify(raw));
      }
    });

    kase('validate fails with revoked after revoke, and a second revoke is false', async (t, clock) => {
      const owner = await t.owners.make();
      const created = await mint(t, clock, owner, 'laptop');
      const ctx = clock.ctx({ purpose: 'request' });
      assert.strictEqual(await t.service.revoke(owner, created.record.id, ctx), true);
      assert.deepStrictEqual(await t.service.validate(created.plaintext, ctx), { ok: false, reason: 'revoked' });
      assert.strictEqual(await t.service.revoke(owner, created.record.id, ctx), false);
      assert.deepStrictEqual(await t.service.list(owner), [], 'a revoked token is left out of the list');
    });

    kase('validate fails with expired once the clock passes expiresAt', async (t, clock) => {
      const owner = await t.owners.make();
      const created = await mint(t, clock, owner, 'laptop');
      assert.ok((await t.service.validate(created.plaintext, clock.ctx({ purpose: 'request' }))).ok);
      clock.tick(HOUR - 1);
      assert.ok((await t.service.validate(created.plaintext, clock.ctx({ purpose: 'request' }))).ok, 'still live one millisecond before expiry');
      clock.tick(1);
      assert.deepStrictEqual(await t.service.validate(created.plaintext, clock.ctx({ purpose: 'request' })), { ok: false, reason: 'expired' });
      assert.deepStrictEqual((await t.service.list(owner)).map((r) => r.id), [created.record.id], 'an expired token is still listed');
    });

    kase('revoke by another owner is false and leaves the token valid (no IDOR)', async (t, clock) => {
      const owner = await t.owners.make();
      const other = await t.owners.make();
      const created = await mint(t, clock, owner, 'laptop');
      const ctx = clock.ctx({ purpose: 'request' });
      assert.strictEqual(await t.service.revoke(other, created.record.id, ctx), false);
      assert.strictEqual(await t.service.revoke(owner, 'conf-token-id-unknown', ctx), false);
      assert.ok((await t.service.validate(created.plaintext, ctx)).ok);
      assert.strictEqual((await t.service.list(owner)).length, 1);
    });

    kase('list returns the tokens of one owner only', async (t, clock) => {
      const owner = await t.owners.make();
      const other = await t.owners.make();
      const mine = await mint(t, clock, owner, 'mine');
      const theirs = await mint(t, clock, other, 'theirs');
      assert.deepStrictEqual((await t.service.list(owner)).map((r) => r.id), [mine.record.id]);
      assert.deepStrictEqual((await t.service.list(other)).map((r) => r.id), [theirs.record.id]);
    });

    kase('revokeAllFor returns the count and invalidates every live token of the owner, agent tokens included', async (t, clock) => {
      const owner = await t.owners.make();
      const other = await t.owners.make();
      const ctx = clock.ctx({ purpose: 'request' });
      const already = await mint(t, clock, owner, 'already revoked');
      assert.strictEqual(await t.service.revoke(owner, already.record.id, ctx), true);
      const pats = [await mint(t, clock, owner, 'pat-1'), await mint(t, clock, owner, 'pat-2')];
      const agent = await mint(t, clock, owner, 'agent', agentOptions(clock));
      const foreign = await mint(t, clock, other, 'foreign');

      assert.strictEqual(await t.service.revokeAllFor(owner, ctx), 3);

      for (const token of [...pats, agent, already]) {
        assert.deepStrictEqual(await t.service.validate(token.plaintext, ctx), { ok: false, reason: 'revoked' }, token.record.name);
      }
      assert.ok((await t.service.validate(foreign.plaintext, ctx)).ok, 'another owner keeps its token');
      assert.deepStrictEqual(await t.service.list(owner), []);
      assert.strictEqual(await t.service.revokeAllFor(owner, ctx), 0);
    });

    kase('an agent token validates as an agent acting for its owner', async (t, clock) => {
      const owner = await t.owners.make();
      const agent = await mint(t, clock, owner, 'agent', agentOptions(clock));
      const result = await t.service.validate(agent.plaintext, clock.ctx({ purpose: 'request' }));
      assert.ok(result.ok);
      assert.strictEqual(result.identity.type, 'agent');
      assert.deepStrictEqual(result.delegation, { onBehalfOf: owner, mode: 'inherit' });
    });

    kase('create refuses a missing expiry, and an expiry not after now, with invalid_expiry', async (t, clock) => {
      const owner = await t.owners.make();
      const ctx = clock.ctx({ purpose: 'request' });
      const refused = async (expiresAt: unknown) => t.service.create(owner, { name: 'x', kind: 'pat', expiresAt } as TokenCreateOptions, ctx);
      assert.deepStrictEqual(await refused(null), { ok: false, code: 'invalid_expiry' }, 'null');
      assert.deepStrictEqual(await refused(undefined), { ok: false, code: 'invalid_expiry' }, 'undefined');
      assert.deepStrictEqual(await refused(new Date(NaN)), { ok: false, code: 'invalid_expiry' }, 'invalid date');
      assert.deepStrictEqual(await refused(ctx.now), { ok: false, code: 'invalid_expiry' }, 'now');
      assert.deepStrictEqual(await refused(new Date(ctx.now.getTime() - MINUTE)), { ok: false, code: 'invalid_expiry' }, 'the past');
      assert.deepStrictEqual(await t.service.list(owner), []);
    });

    kase('rotate returns a new plaintext for the same token, and list never holds it', async (t, clock) => {
      const owner = await t.owners.make();
      const created = await mint(t, clock, owner, 'laptop');
      const r = await rotate(t, clock, owner, created.record.id);
      assert.notStrictEqual(r.plaintext, created.plaintext);
      assert.ok(r.plaintext.length >= 32, 'a token is long enough to be unguessable');
      assert.strictEqual(r.token.id, created.record.id);
      assert.strictEqual(r.token.name, 'laptop');
      assert.strictEqual(r.token.kind, 'pat');
      assert.deepStrictEqual(r.token.owner, owner);
      assert.strictEqual(r.token.expiresAt.getTime(), created.record.expiresAt.getTime());
      assert.ok(!JSON.stringify(r.token).includes(r.plaintext), 'the record holds the plaintext');

      const listed = await t.service.list(owner);
      assert.deepStrictEqual(listed.map((x) => [x.id, x.name]), [[created.record.id, 'laptop']]);
      assert.ok(!JSON.stringify(listed).includes(r.plaintext), 'the list holds the plaintext');

      const valid = await t.service.validate(r.plaintext, clock.ctx({ purpose: 'request' }));
      assert.ok(valid.ok);
      assert.strictEqual(valid.token.id, created.record.id);
    });

    kase('rotate without a grace period ends the old plaintext at once, also when it was validated before', async (t, clock) => {
      const owner = await t.owners.make();
      const ctx = clock.ctx({ purpose: 'request' });
      for (const opts of [undefined, { graceSeconds: 0 }]) {
        const created = await mint(t, clock, owner, 'laptop');
        assert.ok((await t.service.validate(created.plaintext, ctx)).ok, 'warm');
        assert.ok((await t.service.validate(created.plaintext, ctx)).ok, 'warm again');
        const r = await rotate(t, clock, owner, created.record.id, opts);
        assert.deepStrictEqual(await t.service.validate(created.plaintext, ctx), { ok: false, reason: 'invalid_credentials' }, JSON.stringify(opts));
        assert.ok((await t.service.validate(r.plaintext, ctx)).ok, JSON.stringify(opts));
      }
    });

    kase('rotate with a grace period keeps the old plaintext until the grace ends', async (t, clock) => {
      const owner = await t.owners.make();
      const created = await mint(t, clock, owner, 'laptop');
      const r = await rotate(t, clock, owner, created.record.id, { graceSeconds: 60 });
      const ok = async (plaintext: string) => (await t.service.validate(plaintext, clock.ctx({ purpose: 'request' }))).ok;

      assert.ok(await ok(created.plaintext), 'the old plaintext works right after the rotation');
      assert.ok(await ok(r.plaintext));
      clock.tick(60_000 - 1);
      assert.ok(await ok(created.plaintext), 'and one millisecond before the grace ends');
      assert.ok(await ok(r.plaintext));
      clock.tick(1);
      assert.deepStrictEqual(await t.service.validate(created.plaintext, clock.ctx({ purpose: 'request' })), { ok: false, reason: 'invalid_credentials' });
      assert.ok(await ok(r.plaintext));
    });

    kase('the old plaintext names the same token while the grace lasts', async (t, clock) => {
      const owner = await t.owners.make();
      const created = await mint(t, clock, owner, 'laptop');
      await rotate(t, clock, owner, created.record.id, { graceSeconds: 60 });
      const result = await t.service.validate(created.plaintext, clock.ctx({ purpose: 'request' }));
      assert.ok(result.ok);
      assert.deepStrictEqual(result.identity, owner);
      assert.strictEqual(result.token.id, created.record.id);
    });

    kase('a grace period does not outlive the token: expiry and revoke end the old plaintext too', async (t, clock) => {
      const owner = await t.owners.make();
      const ctx = clock.ctx({ purpose: 'request' });
      const expiring = await mint(t, clock, owner, 'expiring');
      const kept = await rotate(t, clock, owner, expiring.record.id, { graceSeconds: 2 * 3600 });
      clock.tick(HOUR);
      for (const plaintext of [expiring.plaintext, kept.plaintext]) {
        assert.deepStrictEqual(await t.service.validate(plaintext, clock.ctx({ purpose: 'request' })), { ok: false, reason: 'expired' });
      }

      const revoked = await mint(t, clock, owner, 'revoked');
      const next = await rotate(t, clock, owner, revoked.record.id, { graceSeconds: 60 });
      assert.strictEqual(await t.service.revoke(owner, revoked.record.id, ctx), true);
      for (const plaintext of [revoked.plaintext, next.plaintext]) {
        assert.deepStrictEqual(await t.service.validate(plaintext, clock.ctx({ purpose: 'request' })), { ok: false, reason: 'revoked' });
      }
    });

    kase('a second rotation drops the plaintext the first one kept in grace', async (t, clock) => {
      const owner = await t.owners.make();
      const ctx = clock.ctx({ purpose: 'request' });
      const first = await mint(t, clock, owner, 'laptop');
      const second = await rotate(t, clock, owner, first.record.id, { graceSeconds: 60 });
      const third = await rotate(t, clock, owner, first.record.id, { graceSeconds: 60 });

      assert.deepStrictEqual(await t.service.validate(first.plaintext, ctx), { ok: false, reason: 'invalid_credentials' });
      assert.ok((await t.service.validate(second.plaintext, ctx)).ok, 'the plaintext just replaced is in grace');
      assert.ok((await t.service.validate(third.plaintext, ctx)).ok);

      const last = await rotate(t, clock, owner, first.record.id);
      for (const plaintext of [second.plaintext, third.plaintext]) {
        assert.deepStrictEqual(await t.service.validate(plaintext, ctx), { ok: false, reason: 'invalid_credentials' });
      }
      assert.ok((await t.service.validate(last.plaintext, ctx)).ok);
    });

    kase('rotate keeps the roles and the limits of the token', async (t, clock) => {
      const owner = await t.owners.make();
      const pat = await mint(t, clock, owner, 'pat', { roles: ['editor', 'viewer'] });
      const agent = await mint(t, clock, owner, 'agent', agentOptions(clock));
      const ctx = clock.ctx({ purpose: 'request' });

      const rotatedPat = await rotate(t, clock, owner, pat.record.id);
      const patResult = await t.service.validate(rotatedPat.plaintext, ctx);
      assert.ok(patResult.ok);
      assert.deepStrictEqual([...(patResult.token.roles ?? [])].sort(), ['editor', 'viewer']);
      assert.deepStrictEqual([...(patResult.ceiling?.roles ?? [])].sort(), ['editor', 'viewer']);

      const rotatedAgent = await rotate(t, clock, owner, agent.record.id);
      const agentResult = await t.service.validate(rotatedAgent.plaintext, ctx);
      assert.ok(agentResult.ok);
      assert.strictEqual(agentResult.identity.type, 'agent');
      assert.deepStrictEqual(agentResult.delegation, { onBehalfOf: owner, mode: 'inherit' });
      assert.deepStrictEqual(agentResult.token.scope?.permissions, ['conf:read']);
    });

    kase('rotate is owner-bound: another owner, an unknown, a revoked and an expired token are not_found', async (t, clock) => {
      const owner = await t.owners.make();
      const other = await t.owners.make();
      const ctx = clock.ctx({ purpose: 'request' });
      const mine = await mint(t, clock, owner, 'mine');
      const revoked = await mint(t, clock, owner, 'revoked');
      assert.strictEqual(await t.service.revoke(owner, revoked.record.id, ctx), true);
      const short = await mint(t, clock, owner, 'short', { expiresAt: new Date(clock.now().getTime() + MINUTE) });

      const notFound = { ok: false, reason: 'not_found' };
      assert.deepStrictEqual(await t.service.rotate(other, mine.record.id, ctx), notFound, 'another owner');
      assert.deepStrictEqual(await t.service.rotate(owner, 'conf-token-id-unknown', ctx), notFound, 'unknown');
      assert.deepStrictEqual(await t.service.rotate(owner, revoked.record.id, ctx), notFound, 'revoked');
      assert.deepStrictEqual(await t.service.rotate(owner, '', ctx), notFound, 'blank');
      assert.ok((await t.service.validate(mine.plaintext, ctx)).ok, 'the foreign attempt left the token alone');

      clock.tick(MINUTE);
      assert.deepStrictEqual(await t.service.rotate(owner, short.record.id, clock.ctx({ purpose: 'request' })), notFound, 'expired');
    });

    kase('rotate refuses a grace period that is negative, fractional, not a number or over seven days, and rotates nothing', async (t, clock) => {
      const owner = await t.owners.make();
      const ctx = clock.ctx({ purpose: 'request' });
      const created = await mint(t, clock, owner, 'laptop');
      for (const graceSeconds of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 604_801, '60' as unknown as number]) {
        await assert.rejects(t.service.rotate(owner, created.record.id, ctx, { graceSeconds }), JSON.stringify(graceSeconds));
      }
      assert.ok((await t.service.validate(created.plaintext, ctx)).ok, 'the plaintext is still the token');
      assert.ok((await t.service.rotate(owner, created.record.id, ctx, { graceSeconds: 604_800 })).ok, 'seven days are allowed');
    });

    kase('update narrows the roles to a subset', async (t, clock) => {
      const owner = await t.owners.make();
      const created = await mint(t, clock, owner, 'laptop', { roles: ['editor', 'viewer'] });
      const ctx = clock.ctx({ purpose: 'request' });
      const result = await t.service.update(owner, created.record.id, { roles: ['viewer'] }, ctx);
      assert.ok(result.ok);
      assert.strictEqual(result.token.id, created.record.id);
      assert.deepStrictEqual(result.token.roles, ['viewer']);
      assert.deepStrictEqual((await t.service.list(owner))[0].roles, ['viewer']);

      const valid = await t.service.validate(created.plaintext, ctx);
      assert.ok(valid.ok, 'the plaintext is the same');
      assert.deepStrictEqual(valid.ceiling?.roles, ['viewer']);
    });

    kase('update refuses to add a role, to empty the roles or to give an agent token roles, and changes nothing', async (t, clock) => {
      const owner = await t.owners.make();
      const created = await mint(t, clock, owner, 'laptop', { roles: ['editor', 'viewer'] });
      const agent = await mint(t, clock, owner, 'agent', agentOptions(clock));
      const ctx = clock.ctx({ purpose: 'request' });
      const invalidScope = { ok: false, reason: 'invalid_scope' };

      assert.deepStrictEqual(await t.service.update(owner, created.record.id, { roles: ['viewer', 'admin'] }, ctx), invalidScope, 'one more role');
      assert.deepStrictEqual(await t.service.update(owner, created.record.id, { roles: ['admin'] }, ctx), invalidScope, 'another role');
      assert.deepStrictEqual(await t.service.update(owner, created.record.id, { roles: [] }, ctx), invalidScope, 'an empty list would unpin the token');
      assert.deepStrictEqual(await t.service.update(owner, created.record.id, { name: 'renamed', roles: ['viewer', 'admin'] }, ctx), invalidScope, 'a refused field spoils the update');
      assert.deepStrictEqual(await t.service.update(owner, agent.record.id, { roles: ['viewer'] }, ctx), invalidScope, 'agent token');

      const listed = (await t.service.list(owner)).find((r) => r.id === created.record.id);
      assert.deepStrictEqual([...(listed?.roles ?? [])].sort(), ['editor', 'viewer']);
      assert.strictEqual(listed?.name, 'laptop');
    });

    kase('update moves the expiry earlier, never later, and never to a time that has passed', async (t, clock) => {
      const owner = await t.owners.make();
      const created = await mint(t, clock, owner, 'laptop');
      const ctx = clock.ctx({ purpose: 'request' });
      const at = (ms: number) => new Date(clock.now().getTime() + ms);
      const invalidExpiry = { ok: false, reason: 'invalid_expiry' };

      const shorter = await t.service.update(owner, created.record.id, { expiresAt: at(30 * MINUTE) }, ctx);
      assert.ok(shorter.ok);
      assert.strictEqual(shorter.token.expiresAt.getTime(), at(30 * MINUTE).getTime());

      assert.deepStrictEqual(await t.service.update(owner, created.record.id, { expiresAt: at(45 * MINUTE) }, ctx), invalidExpiry, 'later than the current expiry');
      assert.deepStrictEqual(await t.service.update(owner, created.record.id, { expiresAt: at(2 * HOUR) }, ctx), invalidExpiry, 'later than the original expiry');
      assert.deepStrictEqual(await t.service.update(owner, created.record.id, { expiresAt: ctx.now }, ctx), invalidExpiry, 'now');
      assert.deepStrictEqual(await t.service.update(owner, created.record.id, { expiresAt: at(-MINUTE) }, ctx), invalidExpiry, 'the past');
      assert.deepStrictEqual(await t.service.update(owner, created.record.id, { expiresAt: new Date(Number.NaN) }, ctx), invalidExpiry, 'invalid date');
      assert.strictEqual((await t.service.list(owner))[0].expiresAt.getTime(), at(30 * MINUTE).getTime(), 'refusals left the expiry alone');

      assert.ok((await t.service.update(owner, created.record.id, { expiresAt: at(30 * MINUTE) }, ctx)).ok, 'the same expiry is allowed');
      clock.tick(30 * MINUTE);
      assert.deepStrictEqual(await t.service.validate(created.plaintext, clock.ctx({ purpose: 'request' })), { ok: false, reason: 'expired' });
    });

    kase('update renames the token, and an update with no change is a no-op', async (t, clock) => {
      const owner = await t.owners.make();
      const created = await mint(t, clock, owner, 'laptop');
      const ctx = clock.ctx({ purpose: 'request' });
      const renamed = await t.service.update(owner, created.record.id, { name: 'workstation' }, ctx);
      assert.ok(renamed.ok);
      assert.strictEqual(renamed.token.name, 'workstation');
      assert.strictEqual(renamed.token.id, created.record.id);
      assert.deepStrictEqual((await t.service.list(owner)).map((r) => r.name), ['workstation']);
      assert.ok((await t.service.validate(created.plaintext, ctx)).ok, 'the plaintext is the same');

      const same = await t.service.update(owner, created.record.id, {}, ctx);
      assert.ok(same.ok);
      assert.deepStrictEqual(same.token, renamed.token);
    });

    kase('update is owner-bound: another owner, an unknown and a revoked token are not_found', async (t, clock) => {
      const owner = await t.owners.make();
      const other = await t.owners.make();
      const ctx = clock.ctx({ purpose: 'request' });
      const mine = await mint(t, clock, owner, 'mine', { roles: ['editor', 'viewer'] });
      const revoked = await mint(t, clock, owner, 'revoked');
      assert.strictEqual(await t.service.revoke(owner, revoked.record.id, ctx), true);

      const notFound = { ok: false, reason: 'not_found' };
      assert.deepStrictEqual(await t.service.update(other, mine.record.id, { name: 'taken' }, ctx), notFound, 'another owner');
      assert.deepStrictEqual(await t.service.update(owner, 'conf-token-id-unknown', { name: 'x' }, ctx), notFound, 'unknown');
      assert.deepStrictEqual(await t.service.update(owner, revoked.record.id, { name: 'x' }, ctx), notFound, 'revoked');
      assert.strictEqual((await t.service.list(owner)).find((r) => r.id === mine.record.id)?.name, 'mine');
    });

    kase('a cached validation sees a rotation at once', async (t, clock) => {
      const owner = await t.owners.make();
      const created = await mint(t, clock, owner, 'laptop');
      const ctx = clock.ctx({ purpose: 'request' });
      for (let i = 0; i < 3; i++) {
        assert.ok((await t.service.validate(created.plaintext, ctx)).ok, 'warm');
      }

      const r = await rotate(t, clock, owner, created.record.id);
      assert.deepStrictEqual(await t.service.validate(created.plaintext, ctx), { ok: false, reason: 'invalid_credentials' });
      assert.ok((await t.service.validate(r.plaintext, ctx)).ok);
      assert.ok((await t.service.validate(r.plaintext, ctx)).ok, 'and the new plaintext is cached in turn');

      assert.strictEqual(await t.service.revoke(owner, created.record.id, ctx), true);
      assert.deepStrictEqual(await t.service.validate(r.plaintext, ctx), { ok: false, reason: 'revoked' });
    });

    kase('revokeByPlaintext revokes the token of that plaintext only, and a second call is false', async (t, clock) => {
      const owner = await t.owners.make();
      const other = await t.owners.make();
      const ctx = clock.ctx({ purpose: 'request' });
      const mine = await mint(t, clock, owner, 'mine');
      const sibling = await mint(t, clock, owner, 'sibling');
      const foreign = await mint(t, clock, other, 'foreign');

      assert.strictEqual(await t.service.revokeByPlaintext(mine.plaintext, ctx), true);
      assert.deepStrictEqual(await t.service.validate(mine.plaintext, ctx), { ok: false, reason: 'revoked' });
      assert.deepStrictEqual((await t.service.list(owner)).map((r) => r.id), [sibling.record.id], 'a revoked token is left out of the list');
      assert.ok((await t.service.validate(sibling.plaintext, ctx)).ok, 'another token of the owner stays valid');
      assert.ok((await t.service.validate(foreign.plaintext, ctx)).ok, 'another owner keeps its token');

      assert.strictEqual(await t.service.revokeByPlaintext(mine.plaintext, ctx), false);
      assert.deepStrictEqual(await t.service.validate(mine.plaintext, ctx), { ok: false, reason: 'revoked' });
    });

    kase('revokeByPlaintext then revoke by id: only the first one revokes', async (t, clock) => {
      const owner = await t.owners.make();
      const ctx = clock.ctx({ purpose: 'request' });
      const created = await mint(t, clock, owner, 'laptop');
      assert.strictEqual(await t.service.revokeByPlaintext(created.plaintext, ctx), true);
      assert.strictEqual(await t.service.revoke(owner, created.record.id, ctx), false);

      const again = await mint(t, clock, owner, 'again');
      assert.strictEqual(await t.service.revoke(owner, again.record.id, ctx), true);
      assert.strictEqual(await t.service.revokeByPlaintext(again.plaintext, ctx), false);
    });

    kase('revokeByPlaintext evicts a cached validation at once', async (t, clock) => {
      const owner = await t.owners.make();
      const created = await mint(t, clock, owner, 'laptop');
      const ctx = clock.ctx({ purpose: 'request' });
      for (let i = 0; i < 3; i++) {
        assert.ok((await t.service.validate(created.plaintext, ctx)).ok, 'warm');
      }

      assert.strictEqual(await t.service.revokeByPlaintext(created.plaintext, ctx), true);
      assert.deepStrictEqual(await t.service.validate(created.plaintext, ctx), { ok: false, reason: 'revoked' });
    });

    kase('revokeByPlaintext revokes an agent token and no other token of its owner', async (t, clock) => {
      const owner = await t.owners.make();
      const ctx = clock.ctx({ purpose: 'request' });
      const agent = await mint(t, clock, owner, 'agent', agentOptions(clock));
      const pat = await mint(t, clock, owner, 'pat');

      assert.strictEqual(await t.service.revokeByPlaintext(agent.plaintext, ctx), true);
      assert.deepStrictEqual(await t.service.validate(agent.plaintext, ctx), { ok: false, reason: 'revoked' });
      assert.ok((await t.service.validate(pat.plaintext, ctx)).ok);
    });

    kase('revokeByPlaintext is false for an unknown, altered, blank or non-string plaintext and changes nothing', async (t, clock) => {
      const owner = await t.owners.make();
      const created = await mint(t, clock, owner, 'laptop');
      const ctx = clock.ctx({ purpose: 'request' });
      const bad: unknown[] = ['conf-token-never-issued', created.plaintext + 'x', created.plaintext.slice(1), created.plaintext.toUpperCase(), '', ' ', 'x'.repeat(100_000), undefined, null, 42, {}];
      for (const raw of bad) {
        assert.strictEqual(await t.service.revokeByPlaintext(raw as string, ctx), false, JSON.stringify(raw)?.slice(0, 40));
      }
      assert.ok((await t.service.validate(created.plaintext, ctx)).ok, 'the token is still live');
      assert.strictEqual((await t.service.list(owner)).length, 1);
    });

    kase('revokeByPlaintext with the previous plaintext revokes the token while the grace lasts', async (t, clock) => {
      const owner = await t.owners.make();
      const created = await mint(t, clock, owner, 'laptop');
      const next = await rotate(t, clock, owner, created.record.id, { graceSeconds: 60 });
      clock.tick(60_000 - 1);
      const ctx = clock.ctx({ purpose: 'request' });

      assert.strictEqual(await t.service.revokeByPlaintext(created.plaintext, ctx), true, 'the old plaintext still proves possession');
      for (const plaintext of [created.plaintext, next.plaintext]) {
        assert.deepStrictEqual(await t.service.validate(plaintext, ctx), { ok: false, reason: 'revoked' });
      }
      assert.deepStrictEqual(await t.service.list(owner), []);
    });

    kase('revokeByPlaintext with a plaintext whose grace has ended is false and leaves the token live', async (t, clock) => {
      const owner = await t.owners.make();
      const created = await mint(t, clock, owner, 'laptop');
      const next = await rotate(t, clock, owner, created.record.id, { graceSeconds: 60 });
      clock.tick(60_000);
      const ctx = clock.ctx({ purpose: 'request' });
      assert.strictEqual(await t.service.revokeByPlaintext(created.plaintext, ctx), false, 'grace over');
      assert.ok((await t.service.validate(next.plaintext, ctx)).ok);

      const dropped = await rotate(t, clock, owner, created.record.id);
      assert.strictEqual(await t.service.revokeByPlaintext(next.plaintext, ctx), false, 'rotated without grace');
      assert.ok((await t.service.validate(dropped.plaintext, ctx)).ok);
      assert.strictEqual(await t.service.revokeByPlaintext(dropped.plaintext, ctx), true);
    });

    kase('a cached validation sees an update at once', async (t, clock) => {
      const owner = await t.owners.make();
      const created = await mint(t, clock, owner, 'laptop', { roles: ['editor', 'viewer'] });
      const ctx = clock.ctx({ purpose: 'request' });
      for (let i = 0; i < 3; i++) {
        assert.ok((await t.service.validate(created.plaintext, ctx)).ok, 'warm');
      }

      const expiresAt = new Date(clock.now().getTime() + 30 * MINUTE);
      assert.ok((await t.service.update(owner, created.record.id, { name: 'workstation', roles: ['viewer'], expiresAt }, ctx)).ok);

      const valid = await t.service.validate(created.plaintext, ctx);
      assert.ok(valid.ok);
      assert.strictEqual(valid.token.name, 'workstation');
      assert.deepStrictEqual(valid.ceiling?.roles, ['viewer']);
      assert.strictEqual(valid.token.expiresAt.getTime(), expiresAt.getTime());
    });
  });
}
