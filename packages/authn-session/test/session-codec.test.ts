import { expect } from 'chai';
import { DateTime } from 'luxon';
import { encodeSessionData, decodeSessionData } from '../src/index.js';

describe('Session data codec (encodeSessionData / decodeSessionData)', () => {
  it('round-trips primitive value types (string, number, boolean, null)', () => {
    const data = new Map<string, unknown>([
      ['User', 'a-uuid'],
      ['count', 7],
      ['Authorized', true],
      ['nothing', null],
    ]);

    const restored = decodeSessionData(encodeSessionData(data));

    expect(restored).to.be.instanceOf(Map);
    expect(restored.get('User')).to.equal('a-uuid');
    expect(restored.get('count')).to.equal(7);
    expect(restored.get('Authorized')).to.equal(true);
    expect(restored.get('nothing')).to.equal(null);
  });

  it('round-trips a DateTime value as a DateTime (symmetric replacer/reviver — B5)', () => {
    const when = DateTime.fromISO('2026-03-04T05:06:07.000Z');
    const data = new Map<string, unknown>([['when', when]]);

    const restored = decodeSessionData(encodeSessionData(data));

    const got = restored.get('when');
    expect(DateTime.isDateTime(got), 'value should decode back to a DateTime').to.be.true;
    expect((got as DateTime).toMillis()).to.equal(when.toMillis());
  });

  it('round-trips nested Map and Set values', () => {
    const data = new Map<string, unknown>([
      ['roles', new Set(['admin', 'user'])],
      ['meta', new Map<string, unknown>([['k', 'v']])],
    ]);

    const restored = decodeSessionData(encodeSessionData(data));

    const roles = restored.get('roles') as Set<string>;
    const meta = restored.get('meta') as Map<string, unknown>;
    expect(roles).to.be.instanceOf(Set);
    expect([...roles].sort()).to.deep.equal(['admin', 'user']);
    expect(meta).to.be.instanceOf(Map);
    expect(meta.get('k')).to.equal('v');
  });

  it('decodes an empty map', () => {
    const restored = decodeSessionData(encodeSessionData(new Map()));
    expect(restored).to.be.instanceOf(Map);
    expect(restored.size).to.equal(0);
  });

  // The OBJECT branch: `decodeSessionData` also accepts an already-parsed graph,
  // because a MySQL `json` column comes back from mysql2 parsed. That branch is a
  // second implementation of the reviver, and its array / plain-object recursions
  // are reached by nothing else in this suite - every other case above goes
  // through JSON text. The contract pinned here is equivalence: for any payload,
  // decoding the parsed object must produce exactly what decoding the JSON text
  // produces. A divergence is silent by nature ( the wrong shape decodes to an
  // EMPTY session, not to an error ), so it has to be asserted, not observed.
  describe('object branch (json column / already-parsed payload)', () => {
    // A literal `__proto__` OWN key. Built with `JSON.parse` rather than an
    // object literal on purpose: `{ __proto__: x }` in a literal sets the
    // prototype instead of creating a property, which is the exact confusion the
    // decoder's `defineProperty` guards against.
    function nested(): Record<string, unknown> {
      return JSON.parse('{"theme":"dark","__proto__":"polluted","deeper":{"n":1}}') as Record<string, unknown>;
    }

    function payload() {
      return new Map<string, unknown>([
        // array whose ELEMENTS are tagged - the array recursion has to revive
        // each one, not just pass the array along
        ['Recent', [new Map<string, unknown>([['id', 1]]), new Map<string, unknown>([['id', 2]])]],
        // plain object, incl. one nested a further level down
        ['Profile', nested()],
        // null: `typeof null === 'object'`, so the walk's very first test is what
        // stops it from being treated as a graph
        ['LastError', null],
      ]);
    }

    it('decodes a parsed object to exactly the same session as the equivalent JSON text', () => {
      const encoded = encodeSessionData(payload());

      const fromText = decodeSessionData(encoded);
      const fromObject = decodeSessionData(JSON.parse(encoded));

      expect(fromObject).to.deep.equal(fromText);
    });

    it('rebuilds arrays of Maps, nested plain objects and nulls from the object form', () => {
      const restored = decodeSessionData(JSON.parse(encodeSessionData(payload())));

      const recent = restored.get('Recent') as Array<Map<string, unknown>>;
      expect(recent, 'array must stay an array').to.be.an('array');
      expect(recent.length).to.equal(2);
      expect(recent[0], 'tagged element must be revived to a Map').to.be.instanceOf(Map);
      expect(recent[0].get('id')).to.equal(1);
      expect(recent[1]).to.be.instanceOf(Map);
      expect(recent[1].get('id')).to.equal(2);

      const profile = restored.get('Profile') as Record<string, unknown>;
      expect(profile, 'untagged object must stay a plain object').to.not.be.instanceOf(Map);
      expect(profile.theme).to.equal('dark');
      expect((profile.deeper as Record<string, unknown>).n, 'recursion must reach the second level').to.equal(1);

      expect(restored.get('LastError'), 'null must survive as null').to.equal(null);
      expect(restored.has('LastError'), 'null must not drop the entry').to.equal(true);
    });

    it('installs a literal __proto__ key as an own property on both paths, never on the prototype', () => {
      const encoded = encodeSessionData(payload());

      const paths: Array<[string, Map<string, unknown>]> = [
        ['string path', decodeSessionData(encoded)],
        ['object path', decodeSessionData(JSON.parse(encoded))],
      ];

      for (const [label, restored] of paths) {
        const profile = restored.get('Profile') as Record<string, unknown>;

        expect(Object.prototype.hasOwnProperty.call(profile, '__proto__'), `${label}: __proto__ must be an OWN data property`).to.equal(true);
        expect(Object.getOwnPropertyDescriptor(profile, '__proto__')?.value, `${label}: own value must be the payload's`).to.equal('polluted');
        expect(Object.getPrototypeOf(profile), `${label}: the object's prototype must not have been replaced`).to.equal(Object.prototype);
      }
    });

    it('throws instead of returning an empty session when the payload is neither string nor object', () => {
      // The dangerous failure mode is silence: an empty Map decodes into a
      // session that looks valid and authenticated-but-anonymous, so a store
      // that started handing back null/undefined would log out every user with
      // no error anywhere. These have to raise.
      expect(() => decodeSessionData(null)).to.throw(/expected a JSON string/);
      expect(() => decodeSessionData(undefined)).to.throw(/expected a JSON string/);
      expect(() => decodeSessionData(42)).to.throw(/expected a JSON string/);
      expect(() => decodeSessionData(true)).to.throw(/expected a JSON string/);
    });
  });
});
