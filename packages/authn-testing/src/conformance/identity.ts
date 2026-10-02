import assert from 'node:assert/strict';
import type { IdentityStatus, IdentityStore, PasswordCredentialStore } from '@spinajs/authn/contracts';
import type { FakeClock } from '../fakes/clock.js';
import type { SeedPort } from '../harness/ports.js';
import type { BddApi } from './bdd.js';
import { bddOf, withSubject } from './run.js';

export interface IdentitySubject {
  readonly store: IdentityStore;
  readonly passwords: PasswordCredentialStore;
  readonly seed: SeedPort;
  readonly jit: boolean;
  dispose?(): Promise<void>;
}

const STATUS_FLAGS: readonly { flag: 'active' | 'banned' | 'deleted' | 'invitePending'; value: boolean; title: string }[] = [
  { flag: 'active', value: false, title: 'active false' },
  { flag: 'banned', value: true, title: 'banned' },
  { flag: 'deleted', value: true, title: 'deleted' },
  { flag: 'invitePending', value: true, title: 'invitePending' },
];

export function runIdentityStoreConformance(factory: (k: { clock: FakeClock }) => IdentitySubject | Promise<IdentitySubject>, opts: { title?: string; bdd?: BddApi } = {}): void {
  const bdd = bddOf(opts.bdd);
  const kase = (title: string, body: (s: IdentitySubject) => Promise<void>) =>
    bdd.it(`identity store: ${title}`, async () => {
      await withSubject(factory, true, body);
    });

  bdd.describe(opts.title ?? 'identity store conformance', () => {
    kase('finds by login and by email', async ({ store, seed }) => {
      const a = await seed.user({ login: 'conf-a', email: 'conf-a@example.test' });
      assert.deepStrictEqual(await store.findByLogin('conf-a'), a);
      assert.deepStrictEqual(await store.findByLogin('conf-a@example.test'), a);
    });

    kase('an unknown login is null', async ({ store }) => {
      assert.strictEqual(await store.findByLogin('conf-nobody@example.test'), null);
    });

    for (const { flag, value, title } of STATUS_FLAGS) {
      kase(`status reflects ${title}`, async ({ store, seed }) => {
        const a = await seed.user({ login: `conf-status-${flag}` });
        await seed.setStatus(a, { [flag]: value });
        const st: IdentityStatus = await store.status(a);
        assert.strictEqual(st[flag], value, `status.${flag}`);
        assert.strictEqual(st.exists, true);
      });
    }

    kase('display gives the email', async ({ store, seed }) => {
      const a = await seed.user({ login: 'conf-a', email: 'conf-a@example.test' });
      assert.strictEqual((await store.display(a)).email, 'conf-a@example.test');
    });

    kase('no password reads null; a set hash reads back verbatim', async ({ passwords, seed }) => {
      const b = await seed.user({ login: 'conf-b' });
      assert.strictEqual(await passwords.get(b), null);
      await passwords.set(b, 'kit$hash$1');
      assert.strictEqual(await passwords.get(b), 'kit$hash$1');
    });

    kase('provision exists exactly when JIT is on', async ({ store, jit }) => {
      assert.strictEqual(typeof store.provision === 'function', jit);
    });
  });
}
