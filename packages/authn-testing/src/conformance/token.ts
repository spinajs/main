import assert from 'node:assert/strict';
import type { IdentityRef, TokenCreateOptions, TokenCreateResult, TokenService } from '@spinajs/authn/contracts';
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

async function mint(t: TokenServiceUnderTest, clock: FakeClock, owner: IdentityRef, name: string, over: Partial<TokenCreateOptions> = {}): Promise<Created> {
  const opts = { name, kind: 'pat', expiresAt: new Date(clock.now().getTime() + HOUR), ...over } as TokenCreateOptions;
  const result = await t.service.create(owner, opts, clock.ctx({ purpose: 'request' }));
  assert.ok(result.ok, 'create refused: ' + (result.ok ? '' : result.code));
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
  });
}
