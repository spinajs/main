import 'mocha';
import { expect } from 'chai';

import { canonicalize, policyHash } from '../src/index.js';
import type { PolicyIR, Rewrite } from '../src/index.js';
import { docsIR } from './fixtures/docs.js';

function reversedKeys<T>(v: T): T {
  if (Array.isArray(v)) return v.map(reversedKeys) as T;
  if (v === null || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).reverse()) out[k] = reversedKeys((v as Record<string, unknown>)[k]);
  return out as T;
}

describe('canonicalize', () => {
  it('does not depend on key order', () => {
    expect(canonicalize(reversedKeys(docsIR()))).to.equal(canonicalize(docsIR()));
  });

  it('sorts union and intersection operands and allowed subject types', () => {
    const a = docsIR();
    const b = docsIR();
    const edit = b.types.doc.permissions.edit as { union: Rewrite[] };
    edit.union.reverse();
    b.types.folder.relations.viewer.allowed.reverse();
    b.types.doc.permissions.both = { intersection: [{ computed: 'owner' }, { computed: 'editor' }] };
    a.types.doc.permissions.both = { intersection: [{ computed: 'editor' }, { computed: 'owner' }] };
    expect(canonicalize(b)).to.equal(canonicalize(a));
  });

  it('keeps the order of priority entries', () => {
    const permitFirst: Rewrite = { priority: [{ when: { computed: 'owner' }, then: 'permit' }, { when: { computed: 'banned' }, then: 'deny' }] };
    const denyFirst: Rewrite = { priority: [{ when: { computed: 'banned' }, then: 'deny' }, { when: { computed: 'owner' }, then: 'permit' }] };
    const a = docsIR();
    const b = docsIR();
    a.types.doc.permissions.first = permitFirst;
    b.types.doc.permissions.first = denyFirst;
    expect(canonicalize(a)).to.not.equal(canonicalize(b));
  });

  it('keeps the order of combine models', () => {
    const a = docsIR();
    const b = docsIR();
    a.combine.default = { algorithm: 'first-applicable', models: ['rbac', 'abac'] };
    b.combine.default = { algorithm: 'first-applicable', models: ['abac', 'rbac'] };
    expect(canonicalize(a)).to.not.equal(canonicalize(b));
  });

  it('drops undefined properties', () => {
    const ir = docsIR();
    ir.permissions['doc:read'].fields = undefined;
    expect(canonicalize(ir)).to.equal(canonicalize(docsIR()));
  });

  it('is compact JSON with sorted keys', () => {
    const ir: PolicyIR = { version: 1, types: {}, permissions: {}, caveats: {}, combine: { default: { algorithm: 'deny-overrides' } }, principal: { ceiling: false, delegation: false, ancestry: 'parent', roles: {} }, opaque: [] };
    expect(canonicalize(ir)).to.equal('{"caveats":{},"combine":{"default":{"algorithm":"deny-overrides"}},"opaque":[],"permissions":{},"principal":{"ancestry":"parent","ceiling":false,"delegation":false,"roles":{}},"types":{},"version":1}');
  });
});

describe('policyHash', () => {
  it('is the sha256 hex of the canonical form, stable across key order', () => {
    const hash = policyHash(docsIR());
    expect(hash).to.match(/^[0-9a-f]{64}$/);
    expect(policyHash(reversedKeys(docsIR()))).to.equal(hash);
  });

  it('changes with any policy change', () => {
    const ir = docsIR();
    ir.types.doc.relations.banned.allowed.push('group#member');
    expect(policyHash(ir)).to.not.equal(policyHash(docsIR()));
  });
});
