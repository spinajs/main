import assert from 'node:assert/strict';
import { FakeStrategy } from '../fakes/strategy.js';
import { ALICE, WRONG, expectFailure, pw } from './steps.js';
import { defineCase, defineRule } from './types.js';
import type { AuthnRule } from './types.js';

const strategy = (name: string, kinds: readonly string[], interactive: boolean): FakeStrategy => new FakeStrategy({ name, kinds, interactive, verify: () => ({ ok: false, reason: 'invalid_credentials' }), keys: () => [] });

export const A01: AuthnRule = defineRule('A01', 'credentials go to the listed strategy for their kind', [
  defineCase({
    name: 'A01 credentials go to the listed strategy that accepts their kind',
    facet: 'A01/core',
    needs: ['boot'],
    async run(h, k) {
      const s1 = strategy('one', ['password'], true);
      const s2 = strategy('two', ['bearer'], false);
      const b = await h.boot.start({
        strategies: [
          { name: 'one', service: 'KitOne', instance: s1, listed: true },
          { name: 'two', service: 'KitTwo', instance: s2, listed: true },
        ],
      });
      assert.ok(b.ok, 'the boot succeeds');
      try {
        await b.service.authenticate(pw(ALICE.login, WRONG), k.ctx());
        assert.strictEqual(s1.verifyCalls.length, 1);
        assert.strictEqual(s2.verifyCalls.length, 0);
        await b.service.authenticate({ kind: 'bearer', token: 'kit-token' }, k.ctx({ purpose: 'request' }));
        assert.strictEqual(s2.verifyCalls.length, 1);
        assert.strictEqual(s1.verifyCalls.length, 1);
      } finally {
        await b.dispose();
      }
    },
  }),
  defineCase({
    name: 'A01 a kind no listed strategy accepts fails with unsupported_credentials',
    facet: 'A01/core',
    needs: ['boot'],
    async run(h, k) {
      const s1 = strategy('one', ['password'], true);
      const b = await h.boot.start({ strategies: [{ name: 'one', service: 'KitOne', instance: s1, listed: true }] });
      assert.ok(b.ok, 'the boot succeeds');
      try {
        expectFailure(await b.service.authenticate({ kind: 'kit-unknown' }, k.ctx()), 'unsupported_credentials');
        assert.strictEqual(s1.verifyCalls.length, 0);
        assert.strictEqual(s1.keyCalls.length, 0);
      } finally {
        await b.dispose();
      }
    },
  }),
  defineCase({
    name: 'A01 an unlisted strategy never runs',
    facet: 'A01/core',
    needs: ['boot'],
    async run(h, k) {
      const s1 = strategy('one', ['password'], true);
      const s3 = strategy('three', ['bearer'], true);
      const b = await h.boot.start({
        strategies: [
          { name: 'one', service: 'KitOne', instance: s1, listed: true },
          { name: 'three', service: 'KitThree', instance: s3, listed: false },
        ],
      });
      assert.ok(b.ok, 'the boot succeeds');
      try {
        expectFailure(await b.service.authenticate({ kind: 'bearer', token: 'x' }, k.ctx()), 'unsupported_credentials');
        assert.strictEqual(s3.verifyCalls.length, 0);
        assert.strictEqual(s3.keyCalls.length, 0);
      } finally {
        await b.dispose();
      }
    },
  }),
  defineCase({
    name: 'A01 an unknown service name fails boot',
    facet: 'A01/core',
    needs: ['boot'],
    async run(h) {
      const b = await h.boot.start({ strategies: [{ name: 'ghost', service: 'KitNoSuchStrategy', listed: true }] });
      assert.strictEqual(b.ok, false);
    },
  }),
]);
