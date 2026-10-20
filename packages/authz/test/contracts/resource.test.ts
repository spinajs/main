import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';

import * as root from '../../src/index.js';
import { GLOBAL, resourceKey } from '../../src/contracts/resource.js';
import type { ResourceRef } from '../../src/index.js';

const expect = chai.expect;

describe('resource contracts', () => {
  describe('GLOBAL', () => {
    it('is the frozen $global type-level ref without an id key', () => {
      expect(GLOBAL).to.deep.eq({ type: '$global' });
      expect(Object.keys(GLOBAL)).to.deep.eq(['type']);
      expect('id' in GLOBAL).to.eq(false);
      expect(Object.isFrozen(GLOBAL)).to.eq(true);
    });

    it('is exported from the package root', () => {
      expect(root.GLOBAL).to.eq(GLOBAL);
      expect(root.resourceKey).to.eq(resourceKey);
    });
  });

  describe('resourceKey', () => {
    it('keeps the id raw, colons and slashes included', () => {
      expect(resourceKey({ type: 'file', id: 'uploads:a/b.pdf' })).to.eq('file:uploads:a/b.pdf');
      expect(resourceKey({ type: 'users', id: '42' })).to.eq('users:42');
      expect(resourceKey({ type: 'file', id: 'a%2Fb' })).to.eq('file:a%2Fb');
    });

    it('gives the type alone for a type-level ref', () => {
      expect(resourceKey({ type: 'file' })).to.eq('file');
      expect(resourceKey({ type: 'file', id: undefined })).to.eq('file');
      expect(resourceKey(GLOBAL)).to.eq('$global');
    });

    it('keeps an empty id distinct from a type-level ref', () => {
      expect(resourceKey({ type: 'file', id: '' })).to.eq('file:');
      expect(resourceKey({ type: 'file', id: '' })).to.not.eq(resourceKey({ type: 'file' }));
    });

    it('escapes %, : and / in the type part', () => {
      expect(resourceKey({ type: 'a:b', id: 'c' })).to.eq('a%3Ab:c');
      expect(resourceKey({ type: 'a/b', id: 'c' })).to.eq('a%2Fb:c');
      expect(resourceKey({ type: 'a%b', id: 'c' })).to.eq('a%25b:c');
      expect(resourceKey({ type: '%3A' })).to.eq('%253A');
      expect(resourceKey({ type: '%:/' })).to.eq('%25%3A%2F');
      expect(resourceKey({ type: 'a//b::c%%', id: 'x' })).to.eq('a%2F%2Fb%3A%3Ac%25%25:x');
    });

    it('treats a null id read back from JSON or a row as absent', () => {
      expect(resourceKey({ type: 'file', id: null } as unknown as ResourceRef)).to.eq('file');
    });

    it('is injective on pairs that would collide without escaping', () => {
      const pairs: Array<[ResourceRef, ResourceRef]> = [
        [
          { type: 'a:b', id: 'c' },
          { type: 'a', id: 'b:c' },
        ],
        [
          { type: 'a/b', id: 'c' },
          { type: 'a%2Fb', id: 'c' },
        ],
        [{ type: 'a/b' }, { type: 'a%2Fb' }],
        [
          { type: 'a:b', id: 'c' },
          { type: 'a%3Ab', id: 'c' },
        ],
        [{ type: 'a%' }, { type: 'a%25' }],
        [{ type: 'a:b' }, { type: 'a', id: 'b' }],
        [{ type: 'a:' }, { type: 'a', id: '' }],
        [{ type: 'file' }, { type: 'file', id: '' }],
        [{ type: '' }, { type: '', id: '' }],
        [{ type: '$global' }, { type: '$global', id: '' }],
      ];

      for (const [a, b] of pairs) {
        expect(resourceKey(a), JSON.stringify([a, b])).to.not.eq(resourceKey(b));
      }
    });

    const tricky = (maxLength: number) => fc.string({ unit: fc.constantFrom('a', ':', '/', '%', '2', 'F', '3', 'A', '5'), maxLength });
    const refOf = (s: fc.Arbitrary<string>) => fc.record({ type: s, id: fc.option(s, { nil: undefined }) }, { requiredKeys: ['type'] });
    const same = (a: ResourceRef, b: ResourceRef) => a.type === b.type && a.id === b.id;

    it('maps refs to equal keys exactly when they are equal', () => {
      // A small alphabet and short strings make colliding candidates common.
      const small = refOf(fc.string({ unit: fc.constantFrom('a', ':', '/', '%'), maxLength: 3 }));
      fc.assert(
        fc.property(small, small, (a, b) => (resourceKey(a) === resourceKey(b)) === same(a, b)),
        { numRuns: 5000 },
      );
      fc.assert(fc.property(refOf(tricky(8)), refOf(tricky(8)), (a, b) => (resourceKey(a) === resourceKey(b)) === same(a, b)));
      fc.assert(fc.property(refOf(fc.string()), refOf(fc.string()), (a, b) => (resourceKey(a) === resourceKey(b)) === same(a, b)));
    });

    it('can be decoded back to the ref, so no two refs share a key', () => {
      const decode = (key: string): ResourceRef => {
        const at = key.indexOf(':');
        const unescape = (t: string) => t.replace(/%(25|3A|2F)/g, (_, c: string) => ({ '25': '%', '3A': ':', '2F': '/' }[c]!));
        return at < 0 ? { type: unescape(key) } : { type: unescape(key.slice(0, at)), id: key.slice(at + 1) };
      };

      fc.assert(fc.property(refOf(tricky(8)), (r) => same(decode(resourceKey(r)), r)));
      fc.assert(fc.property(refOf(fc.string()), (r) => same(decode(resourceKey(r)), r)));
    });
  });
});
