import { expect } from 'chai';
import { createHash, randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { DI } from '@spinajs/di';
import { SessionIssuer } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { InvalidOperation } from '@spinajs/exceptions';
import { FakeClock } from '@spinajs/authn-testing';
import { DefaultSessionIssuer, MemorySessionStore, adaptLegacySession, isLegacySessionId } from '../src/index.js';
import type { ISession } from '../src/index.js';
import { uncacheOwned, withSessionConfig } from './support.js';

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
const MIN = 60_000;

const SESSION_CONFIG = { authn: { session: { service: 'MemorySessionStore', expiration: { service: 'SlidingCappedExpiration', ttl: 30, maxLifetime: 480 }, pendingTtlSeconds: 300 } } };

/** Exposes the memory store's rows so a test can plant a 2.x-shaped one. */
class Rows extends MemorySessionStore {
  static of(store: MemorySessionStore): Map<string, ISession> {
    return (store as unknown as { Sessions: Map<string, ISession> }).Sessions;
  }
}

interface Legacy {
  user?: string;
  authorized?: boolean;
  impersonator?: string;
  creation?: DateTime;
  expiration?: DateTime;
  extra?: [string, unknown][];
  rawId?: string;
}

/** A row as 2.x wrote it: raw uuid key, no Subject or State, identity in Data. */
function plantLegacy(store: MemorySessionStore, l: Legacy = {}): string {
  const raw = l.rawId ?? randomUUID();
  const data = new Map<string, unknown>([['Logged', true], ...(l.extra ?? [])]);
  if (l.user !== undefined) data.set('User', l.user);
  data.set('Authorized', l.authorized ?? true);
  if (l.impersonator) data.set('Impersonator', l.impersonator);
  const creation = l.creation ?? DateTime.now().minus({ minutes: 1 });
  Rows.of(store).set(raw, { SessionId: raw, Creation: creation, Expiration: l.expiration ?? creation.plus({ minutes: 30 }), Data: data } as unknown as ISession);
  return raw;
}

async function setup() {
  await withSessionConfig(SESSION_CONFIG, [DefaultSessionIssuer, SessionIssuer]);
  const issuer = await DI.resolve(DefaultSessionIssuer);
  const store = await DI.resolve(MemorySessionStore);
  await store.truncate();
  return { issuer, store };
}

const user = (id: string): IdentityRef => ({ type: 'user', id });

describe('2.x session migration', () => {
  let clock: FakeClock | null = null;

  afterEach(() => {
    clock?.uninstall();
    clock = null;
    uncacheOwned([DefaultSessionIssuer, SessionIssuer]);
  });

  describe('adaptLegacySession', () => {
    it('leaves a 3.0 row alone', () => {
      const row = { SessionId: 'k', Subject: user('a'), State: 'pending', Creation: DateTime.now(), Data: new Map([['User', 'b']]) } as ISession;
      expect(adaptLegacySession(row)).to.equal(row);
    });

    it("reads Subject, Impersonator and State from a 2.x row's Data", () => {
      const row = { SessionId: randomUUID(), Creation: DateTime.now(), Data: new Map<string, unknown>([['User', 'u-1'], ['Authorized', true], ['Impersonator', 'u-9']]) } as unknown as ISession;
      const s = adaptLegacySession(row)!;
      expect(s.Subject).to.deep.equal(user('u-1'));
      expect(s.Impersonator).to.deep.equal(user('u-9'));
      expect(s.State).to.equal('active');
    });

    it("is pending unless 'Authorized' is exactly true", () => {
      for (const authorized of [false, 'true', 1, undefined]) {
        const row = { SessionId: randomUUID(), Creation: DateTime.now(), Data: new Map<string, unknown>([['User', 'u-1'], ['Authorized', authorized]]) } as unknown as ISession;
        expect(adaptLegacySession(row)!.State, String(authorized)).to.equal('pending');
      }
    });

    it("treats a 2.x row without 'User' as absent", () => {
      const row = { SessionId: randomUUID(), Creation: DateTime.now(), Data: new Map<string, unknown>([['Authorized', true]]) } as unknown as ISession;
      expect(adaptLegacySession(row)).to.equal(null);
    });

    it('recognises only uuid v4 as a 2.x id', () => {
      expect(isLegacySessionId(randomUUID())).to.be.true;
      expect(isLegacySessionId('kQ7c1d0yYcH1m3S2bA9x_w')).to.be.false;
      expect(isLegacySessionId(sha256hex('x'))).to.be.false;
      expect(isLegacySessionId('00000000-0000-1000-8000-000000000000'), 'uuid v1').to.be.false;
      expect(isLegacySessionId(randomUUID().toUpperCase()), '2.x wrote lowercase only').to.be.false;
    });
  });

  describe('restore of a 2.x raw id', () => {
    it('migrates the row under sha256(raw) on first use, without logging the user out', async () => {
      const { issuer, store } = await setup();
      const creation = DateTime.now().minus({ minutes: 5 });
      const raw = plantLegacy(store, { user: 'u-1', creation, extra: [['ActiveRole', 'editor']] });

      const r = await issuer.restore(raw);
      expect(r, 'the 2.x session restores').to.not.be.null;
      expect(r!.handle).to.deep.equal({ id: raw, state: 'active' });
      expect(r!.identity).to.deep.equal(user('u-1'));
      expect(r!.data.get('ActiveRole')).to.equal('editor');

      const keys = [...Rows.of(store).keys()];
      expect(keys).to.include(sha256hex(raw));
      expect(keys, 'the raw key is gone').to.not.include(raw);
      const row = Rows.of(store).get(sha256hex(raw))!;
      expect(row.Subject).to.deep.equal(user('u-1'));
      expect(row.State).to.equal('active');
      expect(row.Creation.toMillis(), 'Creation is kept, so the absolute lifetime is not reset').to.equal(creation.toMillis());

      expect(await issuer.restore(raw), 'the same cookie keeps working').to.not.be.null;
    });

    it('builds aal1 password facts with authenticatedAt = Creation (hand-off 9)', async () => {
      const { issuer, store } = await setup();
      const creation = DateTime.now().minus({ minutes: 5 });
      const raw = plantLegacy(store, { user: 'u-1', creation, extra: [['TwoFactorAuth', true]] });

      const f = (await issuer.restore(raw))!.facts;
      expect(f.method).to.equal('password');
      expect(f.strategy).to.equal('local');
      expect(f.assurance, 'a 2.x row cannot show that MFA passed').to.equal('aal1');
      expect([...f.mfa]).to.deep.equal([]);
      expect(f.authenticatedAt.getTime()).to.equal(creation.toMillis());
      expect(f.sessionHandle).to.match(/^[0-9a-f]{64}$/);
    });

    it('carries the impersonator and the 2.x impersonation start', async () => {
      const { issuer, store } = await setup();
      const started = new Date(Date.now() - 10 * MIN).toISOString();
      const raw = plantLegacy(store, { user: 'target', impersonator: 'admin', extra: [['ImpersonationStartedAt', started]] });

      const r = (await issuer.restore(raw))!;
      expect(r.identity).to.deep.equal(user('target'));
      expect(r.facts.impersonator).to.deep.equal(user('admin'));
      expect(r.data.get('ImpersonationStartedAt')).to.equal(started);
      expect(Rows.of(store).get(sha256hex(raw))!.Impersonator).to.deep.equal(user('admin'));
    });

    it('drops the 2.x identity and login-state entries from Data, so no 2.x reader sees a logged-in session', async () => {
      const { issuer, store } = await setup();
      const raw = plantLegacy(store, { user: 'u-1', impersonator: 'u-2', authorized: false, extra: [['TwoFactorAuth', true]] });

      const r = (await issuer.restore(raw))!;
      for (const k of ['User', 'Authorized', 'Impersonator', 'Logged', 'TwoFactorAuth']) {
        expect(r.data.has(k), k).to.be.false;
        expect(Rows.of(store).get(sha256hex(raw))!.Data.has(k), k).to.be.false;
      }
    });

    it('a 2.x row that never passed 2FA comes back pending and keeps no longer than pendingTtlSeconds', async () => {
      clock = new FakeClock();
      clock.install();
      const { issuer, store } = await setup();
      const raw = plantLegacy(store, { user: 'u-1', authorized: false, expiration: DateTime.now().plus({ minutes: 30 }) });

      const r = await issuer.restore(raw);
      expect(r!.handle.state).to.equal('pending');
      expect(Rows.of(store).get(sha256hex(raw))!.Expiration!.toMillis()).to.equal(clock.now().getTime() + 300_000);
      clock.tick(301_000);
      expect(await issuer.restore(raw)).to.be.null;
    });

    it('SR-session absolute timeout: a 2.x row older than maxLifetime does not come back, even for one request', async () => {
      const { issuer, store } = await setup();
      const neverExpires = plantLegacy(store, { user: 'u-1', creation: DateTime.now().minus({ minutes: 481 }) });
      Rows.of(store).get(neverExpires)!.Expiration = undefined;
      const stillLive = plantLegacy(store, { user: 'u-1', creation: DateTime.now().minus({ minutes: 600 }), expiration: DateTime.now().plus({ minutes: 20 }) });

      expect(await issuer.restore(neverExpires)).to.be.null;
      expect(await issuer.restore(stillLive)).to.be.null;
      expect(await issuer.list(user('u-1'))).to.deep.equal([]);
    });

    it('SR-session absolute timeout: elevating a 2.x pending row older than maxLifetime is refused and leaves no session', async () => {
      const { issuer, store } = await setup();
      const raw = plantLegacy(store, { user: 'u-1', authorized: false, creation: DateTime.now().minus({ minutes: 481 }), expiration: DateTime.now().plus({ minutes: 20 }) });

      const pd = (await issuer.restore(raw))!.handle;
      expect(pd.state).to.equal('pending');
      const refused = await issuer.elevate(pd, { mfa: ['totp'] }).catch((e: Error) => e);
      expect(refused).to.be.instanceOf(InvalidOperation);
      expect(Rows.of(store).size).to.equal(0);
    });

    it('a 2.x row without User is absent and not migrated', async () => {
      const { issuer, store } = await setup();
      const raw = plantLegacy(store, {});
      expect(await issuer.restore(raw)).to.be.null;
      expect([...Rows.of(store).keys()]).to.not.include(sha256hex(raw));
    });

    it('an expired 2.x row is absent', async () => {
      const { issuer, store } = await setup();
      const raw = plantLegacy(store, { user: 'u-1', expiration: DateTime.now().minus({ seconds: 1 }) });
      expect(await issuer.restore(raw)).to.be.null;
    });

    it('parallel first uses both restore and leave one hashed row', async () => {
      const { issuer, store } = await setup();
      const raw = plantLegacy(store, { user: 'u-1' });
      const [a, b] = await Promise.all([issuer.restore(raw), issuer.restore(raw)]);
      expect(a).to.not.be.null;
      expect(b).to.not.be.null;
      expect([...Rows.of(store).keys()]).to.deep.equal([sha256hex(raw)]);
    });

    it('SR-18 only a uuid v4 input falls back to a raw lookup', async () => {
      const { issuer, store } = await setup();
      // A row keyed by a non-uuid value, as a store holding a stolen storage key would be read
      Rows.of(store).set('not-a-uuid', { SessionId: 'not-a-uuid', Subject: user('u-1'), State: 'active', Creation: DateTime.now(), Expiration: DateTime.now().plus({ minutes: 30 }), Data: new Map() } as ISession);
      expect(await issuer.restore('not-a-uuid')).to.be.null;

      const h = await issuer.issue(user('u-1'), { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date() });
      expect(await issuer.restore(sha256hex(h.id)), 'a storage key presented as a cookie value').to.be.null;
    });
  });

  describe('revocation and listing reach unmigrated 2.x rows', () => {
    it('revokeAll ends the 2.x rows of the subject and, on request, those it impersonates from', async () => {
      const { issuer, store } = await setup();
      const own = plantLegacy(store, { user: 'admin' });
      const imp = plantLegacy(store, { user: 'target', impersonator: 'admin' });
      const other = plantLegacy(store, { user: 'target' });

      expect(await issuer.revokeAll(user('admin'))).to.equal(1);
      expect(await issuer.restore(own)).to.be.null;
      expect(await issuer.revokeAll(user('admin'), { includeImpersonations: true })).to.equal(1);
      expect(await issuer.restore(imp), 'SR-06 the 2.x impersonation ends with the impersonator').to.be.null;
      expect(await issuer.restore(other)).to.not.be.null;
    });

    it('list shows an unmigrated active 2.x row under the handle it keeps after migration', async () => {
      const { issuer, store } = await setup();
      const raw = plantLegacy(store, { user: 'u-1' });
      plantLegacy(store, { user: 'u-1', authorized: false });

      const rows = await issuer.list(user('u-1'));
      expect(rows, 'pending rows are not listed').to.have.length(1);
      const handle = rows[0].handle;
      expect(handle).to.not.equal(raw);
      expect(handle).to.not.equal(sha256hex(raw));
      expect((await issuer.restore(raw))!.facts.sessionHandle).to.equal(handle);
    });

    it('revokeHandle ends an unmigrated 2.x row of the owner', async () => {
      const { issuer, store } = await setup();
      const raw = plantLegacy(store, { user: 'u-1' });
      const handle = (await issuer.list(user('u-1')))[0].handle;
      expect(await issuer.revokeHandle(user('u-2'), handle)).to.be.false;
      expect(await issuer.revokeHandle(user('u-1'), handle)).to.be.true;
      expect(await issuer.restore(raw)).to.be.null;
    });

    it('revokeHandle ends both rows left by an interrupted migration', async () => {
      const { issuer, store } = await setup();
      const raw = plantLegacy(store, { user: 'u-1' });
      await issuer.restore(raw);
      // a migration that saved the hashed row but crashed before deleting the raw one
      plantLegacy(store, { user: 'u-1', rawId: raw });
      expect(Rows.of(store).size).to.equal(2);

      const handles = (await issuer.list(user('u-1'))).map((r) => r.handle);
      expect(new Set(handles).size, 'both rows carry one handle').to.equal(1);
      expect(await issuer.revokeHandle(user('u-1'), handles[0])).to.be.true;
      expect(Rows.of(store).size).to.equal(0);
      expect(await issuer.restore(raw)).to.be.null;
    });

    it('revoke with a 2.x raw id ends the row whether or not it was migrated', async () => {
      const { issuer, store } = await setup();
      const unmigrated = plantLegacy(store, { user: 'u-1' });
      await issuer.revoke({ id: unmigrated, state: 'active' });
      expect(Rows.of(store).size).to.equal(0);

      const migrated = plantLegacy(store, { user: 'u-1' });
      await issuer.restore(migrated);
      await issuer.revoke({ id: migrated, state: 'active' });
      expect(Rows.of(store).size).to.equal(0);
    });
  });
});
