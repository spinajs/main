import * as chai from 'chai';
import 'mocha';
import { createHash } from 'node:crypto';
import { canonicalJson, payloadHash } from '../src/index.js';

const expect = chai.expect;

describe('payload hashing', () => {
  it('writes a payload the same way whatever order its keys were set in', () => {
    const at = new Date('2026-01-01T00:00:00.000Z');
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).to.eq('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson({ a: 1, 10: 2, b: at })).to.eq('{"10":2,"a":1,"b":"2026-01-01T00:00:00.000Z"}');
    expect(canonicalJson(JSON.parse(JSON.stringify({ b: at, 10: 2, a: 1 })))).to.eq('{"10":2,"a":1,"b":"2026-01-01T00:00:00.000Z"}');
    expect(canonicalJson({ n: 12n })).to.eq('{"n":"12"}');
    expect(canonicalJson(undefined)).to.eq('null');
  });

  it('orders members by UTF-16 code units, as RFC 8785 does, integer-like keys included', () => {
    expect(canonicalJson({ 2: 'b', 10: 'a', a: 1, '+': 0, 1: { 20: 0, 3: 0, b: [{ 11: 0, 9: 0 }] } })).to.eq('{"+":0,"1":{"20":0,"3":0,"b":[{"11":0,"9":0}]},"10":"a","2":"b","a":1}');
    // The sorting example of RFC 8785, section 3.2.3: an emoji's high surrogate sorts before U+FB33.
    const rfc = { '\u20ac': 'Euro Sign', '\r': 'Carriage Return', '\ufb33': 'Hebrew Letter Dalet With Dagesh', 1: 'One', '\ud83d\ude00': 'Emoji: Grinning Face', '\u0080': 'Control', '\u00f6': 'Latin Small Letter O With Diaeresis' };
    expect([...canonicalJson(rfc).matchAll(/:"([^"]+)"/g)].map((m) => m[1])).to.deep.eq(['Carriage Return', 'One', 'Control', 'Latin Small Letter O With Diaeresis', 'Euro Sign', 'Emoji: Grinning Face', 'Hebrew Letter Dalet With Dagesh']);
  });

  it('writes what JSON.stringify writes for values, and refuses a cycle', () => {
    const shared = { x: [1, undefined, () => 1] };
    expect(canonicalJson({ u: undefined, f: () => 1, s: shared, t: shared, n: -0, e: 1e21, i: Infinity, d: '\u2028"\\' })).to.eq(`{"d":${JSON.stringify('\u2028"\\')},"e":1e+21,"i":null,"n":0,"s":{"x":[1,null,null]},"t":{"x":[1,null,null]}}`);
    const sparse: number[] = [];
    sparse[0] = 1;
    sparse[2] = 3;
    expect(canonicalJson({ a: sparse, b: new Array<number>(2) })).to.eq('{"a":[1,null,3],"b":[null,null]}');
    const circular: Record<string, unknown> = { a: [] };
    circular.a = [circular];
    expect(() => canonicalJson(circular)).to.throw(TypeError);
  });

  it('hashes the canonical text with SHA-256', () => {
    const hash = payloadHash({ b: 1, a: 2 });
    expect(hash).to.eq(createHash('sha256').update('{"a":2,"b":1}').digest('hex'));
    expect(hash).to.eq(payloadHash({ a: 2, b: 1 }));
    expect(hash).to.match(/^[0-9a-f]{64}$/);
  });
});
