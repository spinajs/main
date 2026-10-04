import assert from 'node:assert/strict';
import type { IdentityStatus, IdentityStore, PasswordCredentialStore } from '@spinajs/authn/contracts';
import type { FakeClock } from '../fakes/clock.js';
import type { SeedPort } from '../harness/ports.js';
import type { BddApi, TestThis } from '../behaviour/types.js';
import { bddOf, caseTimeout, withSubject } from './run.js';

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
    bdd.it(`identity store: ${title}`, async function (this: TestThis) {
      await withSubject(factory, true, body, { timeoutMs: caseTimeout(this), name: `identity store: ${title}` });
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

    kase('an unconditional set answers true and overwrites', async ({ passwords, seed }) => {
      const b = await seed.user({ login: 'conf-b' });
      assert.strictEqual(await passwords.set(b, 'kit$hash$1'), true);
      assert.strictEqual(await passwords.set(b, 'kit$hash$2'), true);
      assert.strictEqual(await passwords.get(b), 'kit$hash$2');
    });

    kase('a conditional set writes only over the expected value (RFC N3-1)', async ({ passwords, seed }) => {
      const b = await seed.user({ login: 'conf-b' });
      const c = await seed.user({ login: 'conf-c' });
      await passwords.set(b, 'kit$hash$1');
      await passwords.set(c, 'kit$hash$1');
      assert.strictEqual(await passwords.set(b, 'kit$hash$2', 'kit$hash$other'), false, 'a stale expected value');
      assert.strictEqual(await passwords.get(b), 'kit$hash$1');
      assert.strictEqual(await passwords.set(b, 'kit$hash$2', null), false, 'null expects no password');
      assert.strictEqual(await passwords.get(b), 'kit$hash$1');
      assert.strictEqual(await passwords.set(b, 'kit$hash$2', 'kit$hash$1'), true);
      assert.strictEqual(await passwords.get(b), 'kit$hash$2');
      assert.strictEqual(await passwords.get(c), 'kit$hash$1', 'only the given identity changes');
      assert.strictEqual(await passwords.set(b, 'kit$hash$3', 'kit$hash$1'), false, 'the value it replaced is stale now');
      assert.strictEqual(await passwords.get(b), 'kit$hash$2');
    });

    kase('a conditional set with null writes only where no password is stored', async ({ passwords, seed }) => {
      const b = await seed.user({ login: 'conf-b' });
      assert.strictEqual(await passwords.set(b, 'kit$hash$1', 'kit$hash$1'), false, 'no password is not any value');
      assert.strictEqual(await passwords.get(b), null);
      assert.strictEqual(await passwords.set(b, 'kit$hash$1', null), true);
      assert.strictEqual(await passwords.get(b), 'kit$hash$1');
    });

    kase('of parallel conditional sets over one value exactly one writes', async ({ passwords, seed }) => {
      const b = await seed.user({ login: 'conf-b' });
      await passwords.set(b, 'kit$hash$0');
      const hashes = Array.from({ length: 8 }, (_, i) => `kit$hash$p${i}`);
      const wrote = await Promise.all(hashes.map((h) => passwords.set(b, h, 'kit$hash$0')));
      assert.strictEqual(wrote.filter(Boolean).length, 1);
      assert.strictEqual(await passwords.get(b), hashes[wrote.indexOf(true)]);
    });

    kase('provision exists exactly when JIT is on', async ({ store, jit }) => {
      assert.strictEqual(typeof store.provision === 'function', jit);
    });
  });
}
