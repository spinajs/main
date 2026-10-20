import assert from 'node:assert/strict';
import type { HasherPort } from '../harness/ports.js';
import { burst } from '../helpers/concurrency.js';
import { ALICE, auth, expectSuccess, pw, seedUser } from './steps.js';
import { defineCase, defineRule, table } from './types.js';
import type { AuthnRule } from './types.js';

const ARGON2_DEFAULT_PREFIX = '$argon2id$v=19$m=65536,t=3,p=4$';
const PEPPER = { secret: 'kit-pepper-0123456789abcdef', version: 2 };
const NO_PEPPER = { secret: null, version: 1 };

interface RehashRow {
  readonly label: string;
  readonly pepper: { secret: string | null; version: number };
  readonly oldHash: (x: HasherPort) => Promise<string>;
  readonly prefix: string;
}

const REHASH_ROWS: readonly RehashRow[] = [
  { label: 'argon2 parameters', pepper: NO_PEPPER, oldHash: (x) => x.hashWith(ALICE.password, { argon2: { memoryCost: 4096, timeCost: 2, parallelism: 1 }, pepper: null }), prefix: ARGON2_DEFAULT_PREFIX },
  { label: 'no pepper yet', pepper: PEPPER, oldHash: (x) => x.hashWith(ALICE.password, { pepper: null }), prefix: '$sp2$' },
];

export const A03: AuthnRule = defineRule('A03', 'passwords are hashed with argon2id at the library defaults', [
  defineCase({
    name: 'A03 the stored hash starts with the argon2 library defaults',
    facet: 'A03/argon2',
    needs: ['seed', 'passwordStore'],
    config: { authn: { local: { pepper: NO_PEPPER } } },
    async run(h) {
      const a = await seedUser(h, ALICE);
      const stored = await h.passwordStore.get(a);
      assert.ok(stored?.startsWith(ARGON2_DEFAULT_PREFIX), `stored hash ${stored}`);
    },
  }),
  defineCase({
    name: 'A03 with a pepper the stored hash carries the pepper version',
    facet: 'A03/argon2',
    needs: ['seed', 'passwordStore', 'service'],
    config: { authn: { local: { pepper: PEPPER } } },
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const stored = await h.passwordStore.get(a);
      assert.ok(stored !== null && stored.startsWith('$sp2$'), `stored hash ${stored}`);
      assert.ok(stored.includes(ARGON2_DEFAULT_PREFIX), 'the argon2 defaults sit under the pepper tag');
      assert.strictEqual((await auth(h, k, pw(ALICE.login, ALICE.password))).status, 'success');
    },
  }),
  table(REHASH_ROWS, (row) =>
    defineCase({
      name: `A03 a hash under other parameters is rehashed on the next successful login: ${row.label}`,
      facet: 'A03/argon2',
      needs: ['seed', 'passwordStore', 'hasher', 'service'],
      config: { authn: { local: { pepper: row.pepper } } },
      async run(h, k) {
        const a = await seedUser(h, ALICE);
        const old = await row.oldHash(h.hasher);
        await h.passwordStore.set(a, old);
        const res = await auth(h, k, pw(ALICE.login, ALICE.password));
        expectSuccess(res);
        const n = await h.passwordStore.get(a);
        assert.ok(n !== null && n !== old, 'the stored hash changed');
        assert.ok(n.startsWith(row.prefix), `rehashed value ${n}`);
      },
    }),
  ),
  defineCase({
    name: 'A03 SR-03 at most maxConcurrent hashes run',
    facet: 'A03/argon2',
    needs: ['hasher'],
    config: { authn: { local: { hasher: { maxConcurrent: 2 } } } },
    timeoutMs: 60_000,
    async run(h) {
      const r = await burst(8, (i) => h.hasher.hash(`Kit-Pass-${i}-xyz`));
      assert.strictEqual(r.fulfilled().length, 8);
      assert.ok(h.hasher.peakConcurrent() <= 2, `peak ${h.hasher.peakConcurrent()}`);
    },
  }),
]);
