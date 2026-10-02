import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { MetadataActor } from '../harness/ports.js';
import { ALICE, WRONG, auth, expectSuccess, pw, seedUser } from './steps.js';
import { defineCase, defineRule, table } from './types.js';
import type { AuthnRule } from './types.js';

/** One sample per prefix the 2.x metadata layer must refuse (plan SEC1). */
const RESERVED_SAMPLES = ['2fa:token', '2fa:enabled', 'user:2fa:token', 'user:pwd_reset:token', 'user:pwd:reset', 'user:login:attempts', 'user:ban:is_banned', 'user:invite:pending'] as const;

const ACTORS: readonly MetadataActor[] = ['owner', 'admin'];

const WRITE_ROWS = RESERVED_SAMPLES.flatMap((key) => ACTORS.map((actor) => ({ key, actor })));

const FLOW_PREFIXES = ['2fa:', 'user:2fa:', 'user:pwd_reset:', 'user:pwd:', 'user:login:'];

export const A12: AuthnRule = defineRule('A12', 'authentication state never travels through identity metadata', [
  defineCase({
    name: 'A12 SR-02 2fa:enabled write by owner',
    facet: 'A12/api',
    needs: ['metadata', 'seed'],
    async run(h) {
      const a = await seedUser(h, ALICE);
      await h.metadata.seedRaw(a, '2fa:enabled', true);
      assert.strictEqual((await h.metadata.write('owner', a, '2fa:enabled', false)).ok, false);
      assert.ok((await h.metadata.rawKeys(a)).includes('2fa:enabled'), 'the planted row is still there');
      assert.strictEqual((await h.metadata.read('owner', a, '2fa:enabled')).found, false);
    },
  }),
  table(WRITE_ROWS, (row) =>
    defineCase({
      name: `A12 a reserved key write is refused: ${row.key} by ${row.actor}`,
      facet: 'A12/api',
      needs: ['metadata', 'seed'],
      async run(h) {
        const a = await seedUser(h, ALICE);
        assert.strictEqual((await h.metadata.write(row.actor, a, row.key, 'kit')).ok, false);
        assert.ok(!(await h.metadata.rawKeys(a)).includes(row.key), 'no row was written');
      },
    }),
  ),
  defineCase({
    name: "A12 SR-01 admin reads another user's reset token",
    facet: 'A12/api',
    needs: ['metadata', 'seed'],
    async run(h) {
      const a = await seedUser(h, ALICE);
      await h.metadata.seedRaw(a, 'user:pwd_reset:token', randomUUID());
      assert.strictEqual((await h.metadata.read('admin', a, 'user:pwd_reset:token')).found, false);
      assert.ok(!(await h.metadata.list('admin', a)).includes('user:pwd_reset:token'), 'the key is not listed');
    },
  }),
  defineCase({
    name: 'A12 SR-01 owner reads own 2fa secret',
    facet: 'A12/api',
    needs: ['metadata', 'seed'],
    async run(h) {
      const a = await seedUser(h, ALICE);
      await h.metadata.seedRaw(a, '2fa:token', 'JBSWY3DPEHPK3PXP');
      assert.strictEqual((await h.metadata.read('owner', a, '2fa:token')).found, false);
      assert.ok(!(await h.metadata.list('owner', a)).includes('2fa:token'), 'the key is not listed');
    },
  }),
  defineCase({
    name: 'A12 SR-02 delete protected row by id',
    facet: 'A12/api',
    needs: ['metadata', 'seed'],
    async run(h) {
      const a = await seedUser(h, ALICE);
      const id = await h.metadata.seedRaw(a, 'user:2fa:token', 'x');
      assert.strictEqual((await h.metadata.deleteById('admin', a, id)).ok, false);
      assert.strictEqual((await h.metadata.deleteById('owner', a, id)).ok, false);
      assert.ok((await h.metadata.rawKeys(a)).includes('user:2fa:token'), 'the row survives');
    },
  }),
  defineCase({
    name: 'A12 a reserved row cannot be updated by id',
    facet: 'A12/api',
    needs: ['metadata', 'seed'],
    async run(h) {
      const a = await seedUser(h, ALICE);
      const id = await h.metadata.seedRaw(a, 'user:ban:is_banned', false);
      assert.strictEqual((await h.metadata.updateById('admin', a, id, true)).ok, false);
    },
  }),
  defineCase({
    name: 'A12 a plain key stays readable and writable',
    facet: 'A12/api',
    needs: ['metadata', 'seed'],
    async run(h) {
      const a = await seedUser(h, ALICE);
      assert.strictEqual((await h.metadata.write('owner', a, 'user:avatar', 'kit.png')).ok, true);
      assert.deepStrictEqual(await h.metadata.read('owner', a, 'user:avatar'), { found: true, value: 'kit.png' });
      assert.ok((await h.metadata.list('admin', a)).includes('user:avatar'), 'an admin lists it');
    },
  }),
  table(RESERVED_SAMPLES, (key) =>
    defineCase({
      name: `A12 the identity layer refuses reserved keys: ${key}`,
      facet: 'A12/identity',
      needs: ['identityMeta', 'seed'],
      async run(h) {
        const a = await seedUser(h, ALICE);
        assert.strictEqual((await h.identityMeta.set(a, key, 'kit')).ok, false);
      },
    }),
  ),
  defineCase({
    name: 'A12 authentication flows write no state into identity metadata',
    facet: 'A12/flow',
    needs: ['metadata', 'service', 'password', 'seed'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      for (let i = 0; i < 3; i++) {
        await auth(h, k, pw(ALICE.login, WRONG));
      }
      expectSuccess(await auth(h, k, pw(ALICE.login, ALICE.password)));
      await h.password.requestReset(ALICE.login, k.ctx());
      const keys = await h.metadata.rawKeys(a);
      const offending = keys.filter((key) => FLOW_PREFIXES.some((p) => key.startsWith(p)));
      assert.deepStrictEqual(offending, [], 'no authentication state in metadata');
    },
  }),
]);
