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

  it('hashes the canonical text with SHA-256', () => {
    const hash = payloadHash({ b: 1, a: 2 });
    expect(hash).to.eq(createHash('sha256').update('{"a":2,"b":1}').digest('hex'));
    expect(hash).to.eq(payloadHash({ a: 2, b: 1 }));
    expect(hash).to.match(/^[0-9a-f]{64}$/);
  });
});
