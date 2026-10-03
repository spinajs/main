import { expect } from 'chai';
import { createHash, randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { DI } from '@spinajs/di';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnFacts, IdentityRef, SessionHandle } from '@spinajs/authn/contracts';
import { FakeClock } from '@spinajs/authn-testing';
import { DefaultSessionIssuer, MemorySessionStore } from '../src/index.js';
import type { ISession } from '../src/index.js';
import { plantLegacyRow, uncacheOwned, withSessionConfig } from './support.js';

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
const MIN = 60_000;

const alice: IdentityRef = { type: 'user', id: 'alice' };
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

const rowsOf = (store: MemorySessionStore) => (store as unknown as { Sessions: Map<string, ISession> }).Sessions;
const rowOf = (store: MemorySessionStore, h: SessionHandle) => rowsOf(store).get(sha256hex(h.id));

/** Runs `action` once, right before the store's next write (save or touch): a revocation landing between the issuer's read and write. */
function beforeNextWrite(store: MemorySessionStore, action: () => Promise<unknown>): void {
  const s = store as unknown as Record<'save' | 'touch', (x: ISession) => Promise<unknown>>;
  const originals = { save: s.save, touch: s.touch };
  let fired = false;
  for (const name of ['save', 'touch'] as const) {
    s[name] = async (x: ISession) => {
      if (!fired) {
        fired = true;
        s.save = originals.save;
        s.touch = originals.touch;
        await action();
      }
      return originals[name].call(store, x);
    };
  }
}

const rejects = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch {
    return true;
  }
  return false;
};

describe('DefaultSessionIssuer hardening', () => {
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

  describe('elevate', () => {
    it('SR-session fixation: elevate kills the pending id', async () => {
      const { issuer } = await setup();
      const pd = await issuer.issue(alice, facts(), { pending: { steps: ['totp'] } });
      const e = await issuer.elevate(pd, { mfa: ['totp'] });

      expect(e.id).to.not.equal(pd.id);
      expect(e.state).to.equal('active');
      expect(await issuer.restore(pd.id), 'the pending id is dead').to.be.null;
    });

    it('drops the pending entry, keeps Creation and switches to the active expiration', async () => {
      const c = fake();
      const { issuer, store } = await setup();
      const pd = await issuer.issue(alice, facts(), { pending: { steps: ['totp'] } });
      const creation = rowOf(store, pd)!.Creation.toMillis();
      expect(rowOf(store, pd)!.Expiration!.toMillis(), 'the pending TTL').to.equal(c.now().getTime() + 300_000);
      c.tick(60_000);

      const e = await issuer.elevate(pd, { mfa: ['totp'] });
      const row = rowOf(store, e)!;
      expect(row.State).to.equal('active');
      expect(row.Creation.toMillis()).to.equal(creation);
      expect(row.Expiration!.toMillis(), 'the active idle timeout from now').to.equal(c.now().getTime() + 30 * MIN);
      expect([...row.Data.keys()].filter((k) => k === 'authn:pending')).to.deep.equal([]);
    });

    it('sets aal2 and the passed steps, and ignores impersonator and sessionHandle in the input', async () => {
      const { issuer } = await setup();
      const pd = await issuer.issue(alice, facts(), { pending: { steps: ['totp'] } });
      const e = await issuer.elevate(pd, { mfa: ['totp'], assurance: 'aal1', impersonator: { type: 'user', id: 'mallory' }, sessionHandle: 'forged' });

      const r = (await issuer.restore(e.id))!;
      expect(r.facts.assurance).to.equal('aal2');
      expect([...r.facts.mfa]).to.deep.equal(['totp']);
      expect(r.facts.impersonator).to.equal(undefined);
      expect(r.facts.sessionHandle).to.not.equal('forged');
      expect(r.identity).to.deep.equal(alice);
    });

    it('refuses an active, an unknown and an expired session', async () => {
      const c = fake();
      const { issuer } = await setup();
      const active = await issuer.issue(alice, facts());
      expect(await rejects(issuer.elevate(active, { mfa: ['totp'] }))).to.be.true;
      expect(await rejects(issuer.elevate({ id: 'kQ7c1d0yYcH1m3S2bA9x_w', state: 'pending' }, {}))).to.be.true;

      const pd = await issuer.issue(alice, facts(), { pending: { steps: ['totp'] } });
      c.tick(301_000);
      expect(await rejects(issuer.elevate(pd, { mfa: ['totp'] }))).to.be.true;
    });
  });

  describe('SR-07 pending sessions (store part)', () => {
    it('SR-07 a pending session is not listed and cannot be activated through set', async () => {
      const { issuer } = await setup();
      const pd = await issuer.issue(alice, facts(), { pending: { steps: ['totp'] } });

      expect(await rejects(issuer.set(pd, 'State', 'active'))).to.be.true;
      expect(await rejects(issuer.set(pd, 'Authorized', true))).to.be.true;
      expect(await rejects(issuer.set(pd, 'authn:pending', null))).to.be.true;
      expect((await issuer.restore(pd.id))!.handle.state).to.equal('pending');
      expect(await issuer.list(alice)).to.deep.equal([]);
    });

    it('SR-07 use never extends a pending session', async () => {
      const c = fake();
      const { issuer } = await setup();
      const pd = await issuer.issue(alice, facts(), { pending: { steps: ['totp'] } });
      for (let i = 0; i < 5; i++) {
        c.tick(59_000);
        expect(await issuer.restore(pd.id)).to.not.be.null;
        await issuer.set(pd, 'Probe', i);
      }
      c.tick(6_000);
      expect(await issuer.restore(pd.id)).to.be.null;
    });
  });

  describe('SR-session revocation: a write never undoes a concurrent revocation', () => {
    it('restore (idle refresh) after a ban does not bring the session back', async () => {
      const c = fake();
      const { issuer, store } = await setup();
      const h = await issuer.issue(alice, facts());
      c.tick(2 * MIN);

      beforeNextWrite(store, () => issuer.revokeAll(alice));
      await issuer.restore(h.id);

      expect(await issuer.restore(h.id)).to.be.null;
      expect(rowsOf(store).size).to.equal(0);
    });

    it('set after a ban fails and does not bring the session back', async () => {
      const { issuer, store } = await setup();
      const h = await issuer.issue(alice, facts());

      beforeNextWrite(store, () => issuer.revokeAll(alice));
      expect(await rejects(issuer.set(h, 'ActiveRole', 'editor'))).to.be.true;

      expect(await issuer.restore(h.id)).to.be.null;
      expect(rowsOf(store).size).to.equal(0);
    });

    it('rotate after a ban fails and leaves no working session', async () => {
      const { issuer, store } = await setup();
      const h = await issuer.issue(alice, facts());

      beforeNextWrite(store, () => issuer.revokeAll(alice));
      expect(await rejects(issuer.rotate(h))).to.be.true;

      expect(await issuer.restore(h.id)).to.be.null;
      expect(rowsOf(store).size, 'no rotated row survives').to.equal(0);
    });

    it('elevate after a ban fails and leaves no working session', async () => {
      const { issuer, store } = await setup();
      const pd = await issuer.issue(alice, facts(), { pending: { steps: ['totp'] } });

      beforeNextWrite(store, () => issuer.revokeAll(alice));
      expect(await rejects(issuer.elevate(pd, { mfa: ['totp'] }))).to.be.true;

      expect(rowsOf(store).size).to.equal(0);
    });

    it('rotate after a logout of the old id fails and leaves no working session', async () => {
      const { issuer, store } = await setup();
      const h = await issuer.issue(alice, facts());

      beforeNextWrite(store, () => issuer.revoke(h));
      expect(await rejects(issuer.rotate(h))).to.be.true;
      expect(rowsOf(store).size).to.equal(0);
    });

    it('the first use of a 2.x id after a ban does not migrate it back', async () => {
      const { issuer, store } = await setup();
      const raw = randomUUID();
      const creation = DateTime.now().minus({ minutes: 1 });
      plantLegacyRow(store, { rawId: raw, user: 'u-1', authorized: true, creation, expiration: creation.plus({ minutes: 30 }) });

      beforeNextWrite(store, () => issuer.revokeAll({ type: 'user', id: 'u-1' }));
      expect(await issuer.restore(raw)).to.be.null;
      expect(rowsOf(store).size).to.equal(0);
    });
  });

  describe('malformed handles', () => {
    for (const bad of [undefined, null, 42, '', 'x'.repeat(129)]) {
      it(`answers a malformed handle id (${String(bad).slice(0, 12)}) without a TypeError`, async () => {
        const { issuer } = await setup();
        const h = { id: bad, state: 'active' } as unknown as SessionHandle;
        await issuer.revoke(h);
        expect(await issuer.revokeAll(carol, { except: h })).to.equal(0);
        expect(await issuer.list(carol, { current: h })).to.deep.equal([]);
        for (const p of [issuer.rotate(h), issuer.set(h, 'k', 'v'), issuer.elevate(h, {})]) {
          try {
            await p;
            expect.fail('must reject');
          } catch (e) {
            expect(e).to.not.be.instanceOf(TypeError);
            expect(e).to.be.instanceOf(InvalidArgument);
          }
        }
      });
    }

    it('refuses a reserved key with InvalidArgument and an unknown session with InvalidOperation', async () => {
      const { issuer } = await setup();
      const h = await issuer.issue(alice, facts());
      const reserved = await issuer.set(h, 'authn:facts', {}).catch((e: Error) => e);
      expect(reserved).to.be.instanceOf(InvalidArgument);
      const unknown = await issuer.rotate({ id: 'kQ7c1d0yYcH1m3S2bA9x_w', state: 'active' }).catch((e: Error) => e);
      expect(unknown).to.be.instanceOf(InvalidOperation);
      const active = await issuer.elevate(h, {}).catch((e: Error) => e);
      expect(active).to.be.instanceOf(InvalidOperation);
    });
  });
});
