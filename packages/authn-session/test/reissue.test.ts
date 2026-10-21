import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { DI } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnFacts, IdentityRef, SessionHandle } from '@spinajs/authn/contracts';
import { DefaultSessionIssuer, MemorySessionStore } from '../src/index.js';
import type { ISession } from '../src/index.js';
import { uncacheOwned, withSessionConfig } from './support.js';

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

const alice: IdentityRef = { type: 'user', id: 'alice' };
const LOGIN_AT = new Date('2026-10-21T08:00:00Z');

const facts = (over: Partial<AuthnFacts> = {}): AuthnFacts => ({ method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: LOGIN_AT, ...over });

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

/** Runs `action` once, right before the store's next write (save or touch): a revocation landing during the move. */
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

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return null;
}

describe('DefaultSessionIssuer.reissue', () => {
  afterEach(() => {
    uncacheOwned([DefaultSessionIssuer, SessionIssuer]);
  });

  it('moves an active session to a new id with aal2 and the passed steps, keeping its data', async () => {
    const { issuer } = await setup();
    const h = await issuer.issue(alice, facts());
    await issuer.set(h, 'ActiveRole', 'editor');

    const r = await issuer.reissue(h, { assurance: 'aal2', mfa: ['totp'] });

    expect(r.id).to.not.equal(h.id);
    expect(r.state).to.equal('active');
    expect(await issuer.restore(h.id), 'the old id is dead').to.be.null;
    const restored = (await issuer.restore(r.id))!;
    expect(restored.identity).to.deep.equal(alice);
    expect(restored.facts.assurance).to.equal('aal2');
    expect([...restored.facts.mfa]).to.deep.equal(['totp']);
    expect(restored.facts.method).to.equal('password');
    expect(restored.facts.strategy).to.equal('local');
    expect(restored.facts.authenticatedAt.getTime(), 'authenticatedAt is kept unless changed').to.equal(LOGIN_AT.getTime());
    expect(restored.data.get('ActiveRole')).to.equal('editor');
  });

  it('sets authenticatedAt when the change names it', async () => {
    const { issuer } = await setup();
    const h = await issuer.issue(alice, facts());
    const at = new Date('2026-10-21T09:30:00Z');

    const r = await issuer.reissue(h, { authenticatedAt: at });

    const restored = (await issuer.restore(r.id))!;
    expect(restored.facts.authenticatedAt.getTime()).to.equal(at.getTime());
    expect(restored.facts.assurance, 'no assurance in the change keeps the stored one').to.equal('aal1');
  });

  it('keeps the subject, the impersonator, Creation and the expiry', async () => {
    const { issuer, store } = await setup();
    const admin = { type: 'user', id: 'admin' };
    const h = await issuer.issue(alice, facts({ impersonator: admin }));
    const before = rowOf(store, h)!;
    const creation = before.Creation.toMillis();
    const expiration = before.Expiration!.toMillis();

    const r = await issuer.reissue(h, { assurance: 'aal2', mfa: ['totp'] });

    const row = rowOf(store, r)!;
    expect(row.Subject).to.deep.equal(alice);
    expect(row.Impersonator).to.deep.equal(admin);
    expect(row.Creation.toMillis()).to.equal(creation);
    expect(row.Expiration!.toMillis()).to.equal(expiration);
    expect((await issuer.restore(r.id))!.facts.impersonator).to.deep.equal(admin);
  });

  it('refuses a pending session with InvalidOperation and leaves it pending', async () => {
    const { issuer } = await setup();
    const pd = await issuer.issue(alice, facts(), { pending: { steps: ['totp'] } });

    expect(await rejection(issuer.reissue(pd, { assurance: 'aal2', mfa: ['totp'] }))).to.be.instanceOf(InvalidOperation);

    expect((await issuer.restore(pd.id))?.handle.state).to.equal('pending');
  });

  it('refuses an unknown session with InvalidOperation', async () => {
    const { issuer } = await setup();
    expect(await rejection(issuer.reissue({ id: 'kQ7c1d0yYcH1m3S2bA9x_w', state: 'active' }, { assurance: 'aal2' }))).to.be.instanceOf(InvalidOperation);
  });

  it('a ban that lands during the move is not undone', async () => {
    const { issuer, store } = await setup();
    const h = await issuer.issue(alice, facts());

    beforeNextWrite(store, () => issuer.revokeAll(alice));
    expect(await rejection(issuer.reissue(h, { assurance: 'aal2', mfa: ['totp'] }))).to.be.instanceOf(InvalidOperation);

    expect(await issuer.restore(h.id)).to.be.null;
    expect(rowsOf(store).size, 'no reissued row survives').to.equal(0);
  });

  it('a logout of the old id that lands during the move is not undone', async () => {
    const { issuer, store } = await setup();
    const h = await issuer.issue(alice, facts());

    beforeNextWrite(store, () => issuer.revoke(h));
    expect(await rejection(issuer.reissue(h, { assurance: 'aal2', mfa: ['totp'] }))).to.be.instanceOf(InvalidOperation);

    expect(rowsOf(store).size).to.equal(0);
  });

  it('of parallel reissues of one session exactly one succeeds', async () => {
    const { issuer, store } = await setup();
    const h = await issuer.issue(alice, facts());

    const results = await Promise.allSettled([issuer.reissue(h, { assurance: 'aal2', mfa: ['totp'] }), issuer.reissue(h, { assurance: 'aal2', mfa: ['totp'] })]);

    expect(results.filter((r) => r.status === 'fulfilled')).to.have.length(1);
    expect(rowsOf(store).size).to.equal(1);
  });
});
