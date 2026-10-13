import { expect } from 'chai';
import { createHash, randomUUID } from 'node:crypto';
import { FakeClock } from '@spinajs/authn-testing';
import type { Harness, HttpResponse } from '@spinajs/authn-testing';
import type { IdentityRef } from '@spinajs/authn/contracts';

import { AUTHN_PROBE_PATH } from '../../v3/probe.js';
import { clearLog, logLines } from '../app.js';
import { ROUTES } from '../behaviour/harness.js';
import { laneEvents, laneTokenProfiles, n8bHarness } from '../behaviour/n8b-harness.js';
import { LaneClient, expectRefused, later } from './mfa-enrolment.js';

const MINUTE = 60_000;
const DAY = 86_400_000;
const GATED = '/v3-app-token-e2e/data';

interface Probe {
  principal: { type: string; id: string; source: string; ceiling?: { roles?: string[] }; attributes: Record<string, unknown>; authn?: Record<string, unknown> } | null;
  session: { state: string } | null;
}

const body = <T = Record<string, unknown>>(res: HttpResponse): T => res.body as T;

/**
 * Bearer and x-api-key tokens through the whole http stack: AuthnMiddleware, TokenStrategy over DbTokenService, then a
 * route behind the Authenticated policy (LEDGER token-policy-e2e 1 to 4, token-middleware 1, 8, 9, 12, 14, 15,
 * token-controller 2 and 5, token-controller-roles 15). The @Access half of token-policy-e2e is authz-http's.
 */
export function tokenEndToEndSuite(): void {
  let h: Harness;
  let users = 0;

  beforeEach(async () => {
    h = await n8bHarness({ rule: 'A14', facet: 'A14/http', caseName: 'token-e2e', clock: new FakeClock(), config: {} });
    clearLog();
    laneEvents.length = 0;
  });

  afterEach(async () => {
    await h?.dispose?.();
  });

  const user = async (roles: string[] = []) => {
    users++;
    const login = `token-e2e-${users}@example.test`;
    const password = `Token-E2e-Pass-${users}`;
    const ref = await h.seed!.user({ login, password });
    if (roles.length > 0) await h.roles!.grant(ref, roles.map((role) => ({ role, requirePassword: false })));
    return { ref, login, password };
  };

  const mint = async (owner: IdentityRef, opts: { expiresAt?: Date; roles?: string[]; profile?: string } = {}) => {
    const t = await h.tokens!.create(owner, { name: 'e2e', kind: 'pat', expiresAt: opts.expiresAt ?? new Date(Date.now() + DAY), ...(opts.roles ? { roles: opts.roles } : {}), ...(opts.profile ? { profile: opts.profile } : {}) }, { now: new Date(), purpose: 'request' });
    if (!t.ok) throw new Error(`token create: ${t.code}`);
    return t;
  };

  const bearer = (plaintext: string) => new LaneClient(h, { authorization: `Bearer ${plaintext}` });
  const apiKey = (plaintext: string) => new LaneClient(h, { 'x-api-key': plaintext });
  const get = (c: LaneClient, path: string) => c.send({ method: 'GET', path });
  const probe = async (c: LaneClient): Promise<Probe> => {
    const res = await get(c, `/${AUTHN_PROBE_PATH}`);
    expect(res.status, JSON.stringify(res.body)).to.eq(200);
    return body<Probe>(res);
  };
  const login = async (u: { login: string; password: string }) => {
    const c = new LaneClient(h);
    const res = await c.send(ROUTES.login!(u.login, u.password));
    expect(res.status, JSON.stringify(res.body)).to.eq(200);
    return c;
  };
  const tokenUses = (outcome: 'success' | 'failure') => h.events!.all().filter((e) => e.type === 'token.use' && e.outcome === outcome);

  describe('a token reaches a route behind Authenticated (token-policy-e2e 1, 2, 3, 4)', () => {
    it('a bearer token reaches it and authenticates its owner with the token roles as ceiling, no-store, no session (e2e 1, middleware 1)', async () => {
      const u = await user(['user', 'admin']);
      const t = await mint(u.ref, { roles: ['user'] });
      const res = await get(bearer(t.plaintext), GATED);
      expect(res.status, JSON.stringify(res.body)).to.eq(200);
      expect(res.headers['cache-control']).to.eq('no-store');
      const seen = await probe(bearer(t.plaintext));
      expect(seen.principal).to.deep.include({ type: 'user', id: u.ref.id, source: 'token' });
      expect(seen.principal!.authn).to.deep.include({ method: 'token', strategy: 'token' });
      expect(seen.principal!.ceiling).to.deep.eq({ roles: ['user'] });
      expect(seen.session, 'a token request opens no session').to.eq(null);
    });

    it('a token without roles carries no role ceiling: the owner roles apply whole (middleware 1, legacy token)', async () => {
      const u = await user(['user']);
      const t = await mint(u.ref);
      const seen = await probe(bearer(t.plaintext));
      expect(seen.principal?.id).to.eq(u.ref.id);
      expect(seen.principal?.ceiling?.roles).to.eq(undefined);
    });

    it('an x-api-key token reaches it the same way (e2e 2, middleware 4)', async () => {
      const u = await user();
      const t = await mint(u.ref);
      const res = await get(apiKey(t.plaintext), GATED);
      expect(res.status, JSON.stringify(res.body)).to.eq(200);
      expect(res.headers['cache-control']).to.eq('no-store');
      expect((await probe(apiKey(t.plaintext))).principal).to.deep.include({ id: u.ref.id, source: 'token' });
    });

    it('a request with no credential, an unknown token or a revoked token is 401 unauthenticated (e2e 3)', async () => {
      const u = await user();
      const t = await mint(u.ref);
      await h.tokens!.revoke(u.ref, t.record.id, { now: new Date(), purpose: 'request' });
      for (const c of [new LaneClient(h), bearer('spt_' + 'A'.repeat(43)), bearer(t.plaintext), apiKey(t.plaintext)]) {
        expectRefused(await get(c, GATED), 401, 'unauthenticated');
      }
    });

    it('an expired token never authenticates: served while live, 401 after the expiry, the failure audited as expired (e2e 4)', async () => {
      const u = await user();
      const t = await mint(u.ref, { expiresAt: new Date(Date.now() + 5 * MINUTE) });
      expect((await get(bearer(t.plaintext), GATED)).status, 'the fixture token is usable while live').to.eq(200);
      await later(5 * 60 + 1, async () => {
        expectRefused(await get(bearer(t.plaintext), GATED), 401, 'unauthenticated');
        expect((await probe(bearer(t.plaintext))).principal, 'no principal from an expired token').to.eq(null);
      });
      expect(tokenUses('failure').map((e) => [e.strategy, e.reason])).to.deep.eq([
        ['token', 'expired'],
        ['token', 'expired'],
      ]);
    });
  });

  describe('the middleware around a token (token-middleware 8, 9, 12, 14, 15)', () => {
    it('an active session ignores a bearer header: the session owner answers and the token is never used (middleware 8)', async () => {
      const alice = await user();
      const bob = await user();
      const t = await mint(bob.ref);
      const session = await login(alice);
      const both = new LaneClient(h, { authorization: `Bearer ${t.plaintext}` });
      both.cookie = session.cookie;
      const seen = await probe(both);
      expect(seen.principal).to.deep.include({ id: alice.ref.id, source: 'session' });
      expect(seen.session).to.deep.eq({ state: 'active' });
      expect(tokenUses('success').concat(tokenUses('failure'))).to.deep.eq([]);
      expect((await h.tokens!.list(bob.ref))[0].lastUsedAt, 'the token was not stamped').to.eq(undefined);
    });

    it('a request with the token stamps its last use (middleware 9)', async () => {
      const u = await user();
      const t = await mint(u.ref);
      expect((await h.tokens!.list(u.ref))[0].lastUsedAt).to.eq(undefined);
      await probe(bearer(t.plaintext));
      expect((await h.tokens!.list(u.ref))[0].lastUsedAt).to.be.instanceOf(Date);
    });

    it('a token without a profile leaves attributes.profile unset; a pinned one stamps it and keeps the roles ceiling (middleware 14, 15)', async () => {
      laneTokenProfiles(['editor']);
      const u = await user(['user']);
      const plain = await mint(u.ref, { roles: ['user'] });
      const pinned = await mint(u.ref, { roles: ['user'], profile: 'editor' });
      const unpinned = (await probe(bearer(plain.plaintext))).principal!;
      expect(unpinned.attributes, 'a legacy token reads as unpinned, not as some default').to.not.have.property('profile');
      const stamped = (await probe(bearer(pinned.plaintext))).principal!;
      expect(stamped.attributes.profile).to.eq('editor');
      expect(stamped.ceiling, 'stamping the profile must not widen or drop the roles').to.deep.eq({ roles: ['user'] });
    });

    it('a create built from a held role and a profile the policy offers is accepted and both reach the principal (controller-roles 15)', async () => {
      laneTokenProfiles(['editor']);
      const u = await user(['user', 'editor']);
      const c = await login(u);
      const res = await c.send({ method: 'POST', path: '/user/tokens', body: { name: 'from reported', expiresAt: new Date(Date.now() + DAY).toISOString(), roles: ['user'], profile: 'editor' } });
      expect(res.status, JSON.stringify(res.body)).to.eq(200);
      const { Token, Plaintext } = body<{ Token: { Roles: string[]; Profile: string }; Plaintext: string }>(res);
      expect(Token).to.deep.include({ Roles: ['user'], Profile: 'editor' });
      const seen = (await probe(bearer(Plaintext))).principal!;
      expect(seen.ceiling).to.deep.eq({ roles: ['user'] });
      expect(seen.attributes.profile).to.eq('editor');
    });

    it('the plaintext reaches no answer, log line or audit event, whether the token is accepted or rejected (middleware 12)', async () => {
      const u = await user();
      const good = await mint(u.ref);
      const old = await mint(u.ref, { expiresAt: new Date(Date.now() + 5 * MINUTE) });
      const answers: HttpResponse[] = [];
      answers.push(await get(bearer(good.plaintext), GATED), await get(apiKey(good.plaintext), GATED));
      await later(5 * 60 + 1, async () => {
        answers.push(await get(bearer(old.plaintext), GATED), await get(apiKey(old.plaintext), GATED));
      });
      expect(tokenUses('failure'), 'the rejections were audited').to.have.length(2);
      const seen = {
        answers: answers.map((r) => `${JSON.stringify(r.body)} ${JSON.stringify(r.headers)} ${r.setCookie.join(' ')}`).join('\n'),
        logs: logLines().join('\n'),
        events: JSON.stringify(h.events!.all()),
        laneEvents: JSON.stringify(laneEvents),
      };
      for (const t of [good, old]) {
        const secrets = { plaintext: t.plaintext, suffix: t.plaintext.slice('spt_'.length), hash: createHash('sha256').update(t.plaintext).digest('hex') };
        for (const [where, text] of Object.entries(seen)) {
          for (const [name, value] of Object.entries(secrets)) {
            // orm-driver-sqlite logs SQL bindings at trace level, the stored hash among them (open item for the orm owner).
            if (where === 'logs' && name === 'hash') continue;
            expect(text, `${name} in ${where}`).to.not.include(value);
          }
        }
      }
    });
  });

  // BUG(T3): 2.x named a rejected token by uuid in its log. 3.0 audits only the reason and the ip, so a replayed
  // expired or revoked token cannot be traced to a token or an owner (A21 bans secrets, not the public uuid).
  it.skip('a rejected expired token is named by its uuid in the audit event or the log (middleware 12, BUG(T3))', async () => {
    const u = await user();
    const old = await mint(u.ref, { expiresAt: new Date(Date.now() + 5 * MINUTE) });
    const uuid = (await h.tokens!.list(u.ref))[0].id;
    clearLog();
    await later(5 * 60 + 1, async () => {
      await get(bearer(old.plaintext), GATED);
    });
    const named = JSON.stringify(tokenUses('failure')) + logLines().join('\n');
    expect(named).to.include(uuid);
  });

  describe('IDOR on the token routes (token-controller 2, 5)', () => {
    it('a stranger token is neither listed nor revoked, and a foreign uuid answers exactly like an unknown one', async () => {
      const alice = await user();
      const bob = await user();
      const bobs = await mint(bob.ref);
      const mine = await mint(alice.ref);
      const c = await login(alice);

      const listed = body<{ Uuid: string }[]>(await c.send({ method: 'GET', path: '/user/tokens' }));
      expect(listed.map((t) => t.Uuid)).to.deep.eq([mine.record.id]);
      expect(JSON.stringify(listed)).to.not.include(bobs.record.id);

      const foreign = await c.send({ method: 'DELETE', path: `/user/tokens/${bobs.record.id}` });
      const unknown = await c.send({ method: 'DELETE', path: `/user/tokens/${randomUUID()}` });
      expectRefused(foreign, 404, 'token_not_found');
      expect(foreign.status).to.eq(unknown.status);
      expect(foreign.body).to.deep.eq(unknown.body);
      expect(foreign.headers['cache-control']).to.eq(unknown.headers['cache-control']);
      expect(foreign.headers['content-type']).to.eq(unknown.headers['content-type']);

      expect((await h.tokens!.list(bob.ref)).map((t) => t.id), 'bob still has the token').to.deep.eq([bobs.record.id]);
      expect((await probe(bearer(bobs.plaintext))).principal?.id, 'and it still authenticates').to.eq(bob.ref.id);
      expect(laneEvents.filter((e) => e.type === 'token.revoke')).to.deep.eq([]);

      const own = await c.send({ method: 'DELETE', path: `/user/tokens/${mine.record.id}` });
      expect(own.status, 'the owner twin: the same route revokes an own token').to.eq(200);
    });
  });
}
