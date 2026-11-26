import 'mocha';
import * as chai from 'chai';

import { declaredKeysAt, droppedKeys, keysAt, nearestKey } from '../src/dropped-keys.js';

const expect = chai.expect;

const same = (value: object) => value;

describe('dropped configuration keys', () => {
  describe('droppedKeys()', () => {
    it('lists the keys the second value lacks, nested and inside arrays, by path', () => {
      const before = { a: 1, typo: 2, nested: { keep: 1, gone: { deep: 1 } }, list: [{ id: 1, x: 1 }, { id: 2 }] };
      const after = { a: 1, added: 3, nested: { keep: 1 }, list: [{ id: 1 }, { id: 2 }] };
      expect(droppedKeys(before, after, same)).to.deep.equal([['typo'], ['nested', 'gone'], ['list', '0', 'x']]);
    });

    it('lists nothing for equal values, added defaults and scalars', () => {
      expect(droppedKeys({ a: { b: [1] } }, { a: { b: [1], c: 2 } }, same)).to.deep.equal([]);
      expect(droppedKeys(5, 5, same)).to.deep.equal([]);
      expect(droppedKeys(null, null, same)).to.deep.equal([]);
    });

    it('does not walk a class instance', () => {
      class Holder {
        public value = 1;
      }
      expect(droppedKeys({ h: new Holder() }, { h: {} }, same)).to.deep.equal([]);
    });

    it('walks a proxy by the target unwrap gives', () => {
      const target = { typo: 1, kept: 2 };
      const proxy = new Proxy({}, {});
      expect(droppedKeys({ s: proxy }, { s: { kept: 2 } }, (v) => (v === proxy ? target : v))).to.deep.equal([['s', 'typo']]);
    });

    it('ends on a value that holds itself', () => {
      const before: Record<string, unknown> = { typo: 1 };
      before.self = before;
      const after: Record<string, unknown> = {};
      after.self = after;
      expect(droppedKeys(before, after, same)).to.deep.equal([['typo']]);
    });
  });

  describe('keysAt()', () => {
    it('gives the keys of the object at a path, through arrays, and none where there is no object', () => {
      const value = { a: { list: [{ id: 1, name: 'x' }] } };
      expect(keysAt(value, ['a', 'list', '0'], same)).to.deep.equal(['id', 'name']);
      expect(keysAt(value, [], same)).to.deep.equal(['a']);
      expect(keysAt(value, ['a', 'missing'], same)).to.deep.equal([]);
    });
  });

  describe('declaredKeysAt()', () => {
    const schema = {
      type: 'object',
      properties: {
        list: { type: 'array', items: { type: 'object', properties: { id: {}, slug: {} } } },
        map: { type: 'object', additionalProperties: { type: 'object', properties: { depth: {} } } },
        ref: { $ref: '#/$defs/x' },
      },
    };

    it('follows properties, items and additionalProperties', () => {
      expect(declaredKeysAt(schema, [])).to.deep.equal(['list', 'map', 'ref']);
      expect(declaredKeysAt(schema, ['list', '3'])).to.deep.equal(['id', 'slug']);
      expect(declaredKeysAt(schema, ['map', 'anyName'])).to.deep.equal(['depth']);
    });

    it('gives nothing behind a $ref or an undeclared key', () => {
      expect(declaredKeysAt(schema, ['ref'])).to.deep.equal([]);
      expect(declaredKeysAt(schema, ['missing', 'x'])).to.deep.equal([]);
    });
  });

  describe('nearestKey()', () => {
    it('suggests the closest key within a third of the key length, ignoring case', () => {
      expect(nearestKey('maxChange', ['maxKeys', 'maxChanges', 'maxDepth'])).to.equal('maxChanges');
      expect(nearestKey('MAXDEPTH', ['maxDepth'])).to.equal('maxDepth');
      expect(nearestKey('timeout', ['timeoutMs'])).to.equal('timeoutMs');
    });

    it('suggests nothing when no key is close', () => {
      expect(nearestKey('colour', ['maxChanges', 'maxKeys'])).to.equal(undefined);
      expect(nearestKey('ab', ['cd'])).to.equal(undefined);
      expect(nearestKey('x', [])).to.equal(undefined);
    });
  });
});
