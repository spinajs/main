import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { DI } from '@spinajs/di';
import { SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnFacts, IdentityRef, SessionHandle } from '@spinajs/authn/contracts';
import { FakeClock } from '@spinajs/authn-testing';
import { DefaultSessionIssuer, MemorySessionStore, SESSION_IP_KEY, SESSION_USER_AGENT_KEY } from '../src/index.js';
import type { ISession } from '../src/index.js';
import { uncacheOwned, withSessionConfig } from './support.js';

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
const MIN = 60_000;

const alice: IdentityRef = { type: 'user', id: 'alice' };
const bob: IdentityRef = { type: 'user', id: 'bob' };
const carol: IdentityRef = { type: 'user', id: 'carol' };

const facts = (over: Partial<AuthnFacts> = {}): AuthnFacts => ({ method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(), ...over });

const SESSION_CONFIG = { authn: { session: { service: 'MemorySessionStore', expiration: { service: 'SlidingCappedExpiration', ttl: 30, maxLifetime: 480 }, pendingTtlSeconds: 300 } } };

async function setup() {
  await withSessionConfig(SESSION_CONFIG, [DefaultSessionIssuer, SessionIssuer]);
  const issuer = await DI.resolve(DefaultSessionIssuer);
  const store = await DI.resolve(MemorySessionStore);
  await store.truncate();
  return { issuer, store };
}

const rowOf = async (store: MemorySessionStore, h: SessionHandle): Promise<ISession | null> => store.restore(sha256hex(h.id));

describe('DefaultSessionIssuer', () => {
  let clock: FakeClock | null = null;

  afterEach(() => {
    clock?.uninstall();
    clock = null;
    uncacheOwned([DefaultSessionIssuer, SessionIssuer]);
  });

  const fake = () => {
    clock = new FakeClock();
    clock.install();
    return clock;
  };

  describe('issue and restore', () => {
    it('is registered as the SessionIssuer', async () => {
      await setup();
      expect(await DI.resolve(SessionIssuer)).to.be.instanceOf(DefaultSessionIssuer);
    });

    it('issues a 128-bit base64url id and stores only sha256(id)', async () => {
      const { issuer, store } = await setup();
      const h = await issuer.issue(alice, facts());

      expect(h.state).to.equal('active');
      expect(h.id).to.match(/^[A-Za-z0-9_-]{22}$/);
      expect(Buffer.from(h.id, 'base64url')).to.have.length(16);
      const row = await rowOf(store, h);
      expect(row, 'stored under sha256(id)').to.not.be.null;
      expect(row!.SessionId).to.equal(sha256hex(h.id));
      expect(await store.restore(h.id), 'nothing stored under the raw id').to.be.null;
    });

    it('stores the subject, state and creation taken in Node', async () => {
      const c = fake();
      const { issuer, store } = await setup();
      const h = await issuer.issue(alice, facts());
      const row = await rowOf(store, h);

      expect({ ...row!.Subject }).to.deep.equal(alice);
      expect(row!.State).to.equal('active');
      expect(row!.Impersonator).to.equal(undefined);
      expect(row!.Creation.toMillis()).to.equal(c.now().getTime());
    });

    it('restores identity, facts and data, and hides its own entries', async () => {
      const at = new Date(Date.now() - 5_000);
      const { issuer } = await setup();
      const h = await issuer.issue(alice, facts({ mfa: ['totp'], assurance: 'aal2', authenticatedAt: at }));
      await issuer.set(h, 'ActiveRole', 'editor');

      const r = await issuer.restore(h.id);
      expect(r).to.not.be.null;
      expect({ ...r!.identity }).to.deep.equal(alice);
      expect(r!.handle).to.deep.equal({ id: h.id, state: 'active' });
      expect(r!.facts.method).to.equal('password');
      expect(r!.facts.strategy).to.equal('local');
      expect(r!.facts.assurance).to.equal('aal2');
      expect([...r!.facts.mfa]).to.deep.equal(['totp']);
      expect(r!.facts.authenticatedAt).to.be.instanceOf(Date);
      expect(r!.facts.authenticatedAt.getTime()).to.equal(at.getTime());
      expect(r!.facts.impersonator).to.equal(undefined);
      expect(r!.data.get('ActiveRole')).to.equal('editor');
      expect([...r!.data.keys()].filter((k) => k.startsWith('authn:'))).to.deep.equal([]);
    });

    it('records facts.impersonator as the session Impersonator', async () => {
      const { issuer, store } = await setup();
      const h = await issuer.issue(carol, facts({ impersonator: { type: 'user', id: 'alice' } }));

      expect({ ...(await rowOf(store, h))!.Impersonator }).to.deep.equal(alice);
      const r = await issuer.restore(h.id);
      expect({ ...r!.identity }).to.deep.equal(carol);
      expect({ ...r!.facts.impersonator }).to.deep.equal({ type: 'user', id: 'alice' });
    });

    it('the session handle is neither the id nor the storage key and is stable across restores', async () => {
      const { issuer } = await setup();
      const h = await issuer.issue(alice, facts());
      const r1 = await issuer.restore(h.id);
      const r2 = await issuer.restore(h.id);

      expect(r1!.facts.sessionHandle).to.match(/^[0-9a-f]{64}$/);
      expect(r1!.facts.sessionHandle).to.not.equal(h.id);
      expect(r1!.facts.sessionHandle).to.not.equal(sha256hex(h.id));
      expect(r2!.facts.sessionHandle).to.equal(r1!.facts.sessionHandle);
    });

    it('a sessionHandle passed in facts is ignored', async () => {
      const { issuer } = await setup();
      const h = await issuer.issue(alice, facts({ sessionHandle: 'forged' }));
      expect((await issuer.restore(h.id))!.facts.sessionHandle).to.not.equal('forged');
    });

    it('restore answers null for unknown, empty and non-string ids', async () => {
      const { issuer } = await setup();
      expect(await issuer.restore('kQ7c1d0yYcH1m3S2bA9x_w')).to.be.null;
      expect(await issuer.restore('')).to.be.null;
      expect(await issuer.restore(undefined as unknown as string)).to.be.null;
      expect(await issuer.restore({} as unknown as string)).to.be.null;
    });

    it('SR-18 a stored hash never works as an id', async () => {
      const { issuer } = await setup();
      const h = await issuer.issue(alice, facts());
      expect(await issuer.restore(sha256hex(h.id))).to.be.null;
    });
  });

  describe('expiry (store-enforced, time taken in Node)', () => {
    it('SR-session idle timeout: an idle session expires and use slides the deadline', async () => {
      const c = fake();
      const { issuer } = await setup();
      const h = await issuer.issue(alice, facts());

      c.tick(29 * MIN);
      expect(await issuer.restore(h.id), 'alive after 29 minutes').to.not.be.null;
      c.tick(29 * MIN);
      expect(await issuer.restore(h.id), 'use slid the deadline').to.not.be.null;
      c.tick(31 * MIN);
      expect(await issuer.restore(h.id)).to.be.null;
    });

    it('SR-session absolute timeout: activity never extends a session past maxLifetime', async () => {
      const c = fake();
      const { issuer } = await setup();
      const h = await issuer.issue(alice, facts());

      for (let i = 1; i <= 23; i++) {
        c.tick(20 * MIN);
        expect(await issuer.restore(h.id), `alive at ${i * 20} minutes`).to.not.be.null;
      }
      c.tick(21 * MIN);
      expect(await issuer.restore(h.id)).to.be.null;
    });

    it('lastSeenAt follows use, written at most once a minute', async () => {
      const c = fake();
      const t0 = c.now().getTime();
      const { issuer } = await setup();
      const h = await issuer.issue(alice, facts());

      c.tick(30_000);
      await issuer.restore(h.id);
      expect((await issuer.list(alice))[0].lastSeenAt.getTime(), 'not rewritten within a minute').to.equal(t0);
      c.tick(40_000);
      await issuer.restore(h.id);
      expect((await issuer.list(alice))[0].lastSeenAt.getTime()).to.equal(t0 + 70_000);
    });
  });

  describe('rotate', () => {
    it('SR-session fixation: rotate gives a new id, kills the old one and keeps the data', async () => {
      const { issuer } = await setup();
      const h1 = await issuer.issue(alice, facts());
      await issuer.set(h1, 'ActiveRole', 'editor');

      const h2 = await issuer.rotate(h1);

      expect(h2.id).to.not.equal(h1.id);
      expect(h2.state).to.equal('active');
      expect(await issuer.restore(h1.id), 'the old id is dead').to.be.null;
      const r = await issuer.restore(h2.id);
      expect(r!.data.get('ActiveRole')).to.equal('editor');
      expect({ ...r!.identity }).to.deep.equal(alice);
    });

    it('keeps Creation and Expiration, so a rotation never resets the lifetime', async () => {
      const c = fake();
      const { issuer, store } = await setup();
      const h1 = await issuer.issue(alice, facts());
      c.tick(10 * MIN);
      const before = await rowOf(store, h1);
      const creation = before!.Creation.toMillis();
      const expiration = before!.Expiration!.toMillis();

      const h2 = await issuer.rotate(h1);
      const after = await rowOf(store, h2);
      expect(after!.Creation.toMillis()).to.equal(creation);
      expect(after!.Expiration!.toMillis()).to.equal(expiration);
    });

    it('keeps the impersonator and the facts', async () => {
      const { issuer } = await setup();
      const h1 = await issuer.issue(carol, facts({ impersonator: { type: 'user', id: 'alice' }, assurance: 'aal2', mfa: ['totp'] }));
      const r = await issuer.restore((await issuer.rotate(h1)).id);
      expect({ ...r!.facts.impersonator }).to.deep.equal({ type: 'user', id: 'alice' });
      expect(r!.facts.assurance).to.equal('aal2');
    });

    it('refuses an unknown session', async () => {
      const { issuer } = await setup();
      let failed = false;
      try {
        await issuer.rotate({ id: 'kQ7c1d0yYcH1m3S2bA9x_w', state: 'active' });
      } catch {
        failed = true;
      }
      expect(failed).to.be.true;
    });
  });

  describe('set', () => {
    for (const key of ['authn:facts', 'authn:pending', 'authn:anything', 'Subject', 'State', 'Impersonator', 'User', 'Authorized']) {
      it(`refuses the reserved key ${key}`, async () => {
        const { issuer } = await setup();
        const h = await issuer.issue(alice, facts());
        let failed = false;
        try {
          await issuer.set(h, key, 'x');
        } catch {
          failed = true;
        }
        expect(failed).to.be.true;
        expect((await issuer.restore(h.id))!.facts.assurance).to.equal('aal1');
      });
    }

    it('cannot raise the assurance through a forged facts entry', async () => {
      const { issuer } = await setup();
      const h = await issuer.issue(alice, facts());
      await issuer.set(h, 'facts', { assurance: 'aal2' }).catch(() => undefined);
      expect((await issuer.restore(h.id))!.facts.assurance).to.equal('aal1');
    });

    it('refuses an unknown session', async () => {
      const { issuer } = await setup();
      let failed = false;
      try {
        await issuer.set({ id: 'kQ7c1d0yYcH1m3S2bA9x_w', state: 'active' }, 'ActiveRole', 'x');
      } catch {
        failed = true;
      }
      expect(failed).to.be.true;
    });
  });

  describe('revoke', () => {
    it('SR-session logout invalidation: revoke deletes the session server-side', async () => {
      const { issuer, store } = await setup();
      const h = await issuer.issue(alice, facts());
      await issuer.revoke(h);
      expect(await issuer.restore(h.id)).to.be.null;
      expect(await rowOf(store, h), 'the row is gone, not just hidden').to.be.null;
    });

    it('revokeAll ends every session of the subject and returns the count', async () => {
      const { issuer } = await setup();
      const a1 = await issuer.issue(alice, facts());
      const a2 = await issuer.issue(alice, facts());
      const b1 = await issuer.issue(bob, facts());

      expect(await issuer.revokeAll(alice)).to.equal(2);
      expect(await issuer.restore(a1.id)).to.be.null;
      expect(await issuer.restore(a2.id)).to.be.null;
      expect(await issuer.restore(b1.id)).to.not.be.null;
    });

    it('SR-06 banning the impersonator ends the impersonation', async () => {
      const { issuer } = await setup();
      const admin = await issuer.issue(alice, facts());
      const impersonation = await issuer.issue(carol, facts({ impersonator: { type: 'user', id: 'alice' } }));
      const carolOwn = await issuer.issue(carol, facts());

      // 2.x deleteByUser(impersonatorId) reached only the impersonator's own sessions
      expect(await issuer.revokeAll(alice)).to.equal(1);
      expect(await issuer.restore(impersonation.id), 'a plain revokeAll keeps it').to.not.be.null;

      expect(await issuer.revokeAll(alice, { includeImpersonations: true })).to.equal(1);
      expect(await issuer.restore(admin.id)).to.be.null;
      expect(await issuer.restore(impersonation.id), 'the impersonation ends with the impersonator').to.be.null;
      expect(await issuer.restore(carolOwn.id), "the target's own session stays").to.not.be.null;
    });

    it('A30 a password change revokes every other session, impersonations included, and keeps the current one', async () => {
      const { issuer } = await setup();
      const current = await issuer.issue(alice, facts());
      const other = await issuer.issue(alice, facts());
      const impersonation = await issuer.issue(carol, facts({ impersonator: { type: 'user', id: 'alice' } }));

      expect(await issuer.revokeAll(alice, { except: current, includeImpersonations: true })).to.equal(2);
      expect(await issuer.restore(current.id)).to.not.be.null;
      expect(await issuer.restore(other.id)).to.be.null;
      expect(await issuer.restore(impersonation.id)).to.be.null;
    });

    it('revokeHandle ends only an owned session, not one the caller impersonates from', async () => {
      const { issuer } = await setup();
      const a1 = await issuer.issue(alice, facts());
      const b1 = await issuer.issue(bob, facts());
      const imp = await issuer.issue(bob, facts({ impersonator: { type: 'user', id: 'alice' } }));

      const hb = (await issuer.list(bob, { current: b1 })).find((x) => x.current)!.handle;
      const hi = (await issuer.list(bob, { current: imp })).find((x) => x.current)!.handle;
      expect(await issuer.revokeHandle(alice, hb), 'not the owner').to.be.false;
      expect(await issuer.revokeHandle(alice, hi), 'the impersonator is not the subject').to.be.false;
      expect(await issuer.revokeHandle(alice, 'nope')).to.be.false;
      expect(await issuer.restore(b1.id)).to.not.be.null;
      expect(await issuer.restore(imp.id)).to.not.be.null;

      const ha = (await issuer.list(alice))[0].handle;
      expect(await issuer.revokeHandle(alice, ha)).to.be.true;
      expect(await issuer.restore(a1.id)).to.be.null;
      expect(await issuer.revokeHandle(bob, hi), 'the subject may end an impersonation of itself').to.be.true;
      expect(await issuer.restore(imp.id)).to.be.null;
    });
  });

  describe('list', () => {
    it('lists live active sessions with handle, times, ip, user agent and the current flag', async () => {
      const c = fake();
      const { issuer } = await setup();
      const h1 = await issuer.issue(alice, facts());
      await issuer.set(h1, SESSION_IP_KEY, '203.0.113.5');
      await issuer.set(h1, SESSION_USER_AGENT_KEY, 'kit-agent');
      const h2 = await issuer.issue(alice, facts());
      await issuer.issue(bob, facts());

      const rows = await issuer.list(alice, { current: h1 });
      expect(rows).to.have.length(2);
      const cur = rows.find((r) => r.current)!;
      expect(cur.handle).to.equal((await issuer.restore(h1.id))!.facts.sessionHandle);
      expect(cur.ip).to.equal('203.0.113.5');
      expect(cur.userAgent).to.equal('kit-agent');
      expect(cur.createdAt.getTime()).to.equal(c.now().getTime());
      expect(cur.lastSeenAt).to.be.instanceOf(Date);
      const rest = rows.find((r) => !r.current)!;
      expect(rest.handle).to.equal((await issuer.restore(h2.id))!.facts.sessionHandle);
      expect(rest).to.not.have.property('current');
      for (const r of rows) {
        expect(r.handle).to.not.equal(h1.id);
        expect(r.handle).to.not.equal(sha256hex(h1.id));
      }
    });

    it('includes sessions in which someone impersonates the subject, but not those the subject impersonates from', async () => {
      const { issuer } = await setup();
      await issuer.issue(bob, facts({ impersonator: { type: 'user', id: 'alice' } }));
      expect(await issuer.list(bob)).to.have.length(1);
      expect(await issuer.list(alice)).to.have.length(0);
    });
  });
});
