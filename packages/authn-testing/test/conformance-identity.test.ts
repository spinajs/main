import assert from 'node:assert/strict';
import 'mocha';
import type { IdentityRef, IdentityStatus } from '@spinajs/authn/contracts';
import { runIdentityStoreConformance } from '../src/conformance/index.js';
import type { IdentitySubject } from '../src/conformance/index.js';
import { FakeIdentityStore, MemoryPasswordCredentialStore, fakeSeedPort } from '../src/fakes/index.js';
import { failedTitles, pendingTitles, runSuite } from './reference/conformance-support.js';

const TITLES = [
  'identity store: finds by login and by email',
  'identity store: an unknown login is null',
  'identity store: status reflects active false',
  'identity store: status reflects banned',
  'identity store: status reflects deleted',
  'identity store: status reflects invitePending',
  'identity store: display gives the email',
  'identity store: no password reads null; a set hash reads back verbatim',
  'identity store: provision exists exactly when JIT is on',
];

const subjectOf = (jit: boolean, tweak: (s: FakeIdentityStore) => IdentitySubject['store'] = (s) => s) => async (): Promise<IdentitySubject> => {
  const store = new FakeIdentityStore({ jit });
  const passwords = new MemoryPasswordCredentialStore();
  return { store: tweak(store), passwords, seed: fakeSeedPort(store, passwords), jit };
};

const run = (factory: Parameters<typeof runIdentityStoreConformance>[0]) => runSuite((bdd) => runIdentityStoreConformance(factory, { bdd }));

describe('runIdentityStoreConformance', () => {
  it('the identity fakes pass every case, with JIT on and off', async () => {
    for (const jit of [true, false]) {
      const r = await run(subjectOf(jit));
      assert.deepEqual(
        r.map((c) => c.title),
        TITLES,
      );
      assert.deepEqual(failedTitles(r), [], `jit ${jit}`);
      assert.deepEqual(pendingTitles(r), []);
    }
  });

  it('disposes the subject once per case', async () => {
    let disposed = 0;
    const base = subjectOf(false);
    const r = await run(async () => ({ ...(await base()), dispose: async () => void disposed++ }));
    assert.equal(disposed, r.length);
  });

  describe('broken stores fail the named case', () => {
    const delegate = (s: FakeIdentityStore, over: Partial<FakeIdentityStore>) => Object.assign(Object.create(s), over) as FakeIdentityStore;
    const expectFails = async (factory: Parameters<typeof run>[0], ...titles: string[]) => assert.deepEqual(failedTitles(await run(factory)), titles);

    it('findByLogin ignores the email', () =>
      expectFails(
        subjectOf(false, (s) => delegate(s, { findByLogin: async (l: string) => (l.includes('@') ? null : s.findByLogin(l)) })),
        TITLES[0],
      ));

    it('findByLogin invents an identity', () =>
      expectFails(
        subjectOf(false, (s) => delegate(s, { findByLogin: async (l: string) => (await s.findByLogin(l)) ?? { type: 'user', id: 'ghost' } })),
        TITLES[1],
      ));

    it('status drops the banned flag', () =>
      expectFails(
        subjectOf(false, (s) => delegate(s, { status: async (id: IdentityRef): Promise<IdentityStatus> => ({ ...(await s.status(id)), banned: false }) })),
        TITLES[3],
      ));

    it('status reports exists false for a known identity', () =>
      expectFails(
        subjectOf(false, (s) => delegate(s, { status: async (id: IdentityRef): Promise<IdentityStatus> => ({ ...(await s.status(id)), exists: false }) })),
        TITLES[2],
        TITLES[3],
        TITLES[4],
        TITLES[5],
      ));

    it('display gives no email', () =>
      expectFails(
        subjectOf(false, (s) => delegate(s, { display: async () => ({}) })),
        TITLES[6],
      ));

    it('provision exists while JIT is off', () =>
      expectFails(
        subjectOf(false, (s) => delegate(s, { provision: async () => ({ type: 'user', id: 'x' }) })),
        TITLES[8],
      ));

    it('the password store changes the hash', async () => {
      const r = await run(async () => {
        const base = await subjectOf(false)();
        const passwords = new MemoryPasswordCredentialStore();
        const set = passwords.set.bind(passwords);
        passwords.set = (id, hash) => set(id, hash.toUpperCase());
        return { ...base, passwords, seed: fakeSeedPort(base.store as FakeIdentityStore, passwords) };
      });
      assert.deepEqual(failedTitles(r), [TITLES[7]]);
    });
  });
});
