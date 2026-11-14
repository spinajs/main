import 'mocha';
import { expect } from 'chai';

import { validateIR } from '../src/index.js';
import type { IRCode, PolicyIR } from '../src/index.js';
import { docsIR } from './fixtures/docs.js';

const rebac = { kind: 'tuples', store: 'authz_rebac_tuple' } as const;

function codes(ir: PolicyIR): Array<[IRCode, string]> {
  return validateIR(ir).map((d) => [d.code, d.path]);
}

describe('validateIR', () => {
  it('accepts the docs fixture', () => {
    expect(validateIR(docsIR())).to.deep.equal([]);
  });

  describe('IR001 unknown relation', () => {
    it('reports a computed name that is neither a relation nor a permission', () => {
      const ir = docsIR();
      ir.types.doc.permissions.edit = { union: [{ computed: 'owner' }, { computed: 'writer' }] };
      expect(codes(ir)).to.deep.equal([['IR001', 'types.doc.permissions.edit.union[1]']]);
    });

    it('reports a tupleset that is not a relation and a target without the computed relation', () => {
      const ir = docsIR();
      ir.types.doc.permissions.a = { tupleToUserset: { tupleset: 'edit', computed: 'view' } };
      ir.types.doc.permissions.b = { tupleToUserset: { tupleset: 'parent', computed: 'publish' } };
      expect(codes(ir)).to.deep.equal([
        ['IR001', 'types.doc.permissions.a'],
        ['IR001', 'types.doc.permissions.b'],
      ]);
    });

    it('reports this on a name without a stored relation', () => {
      const ir = docsIR();
      ir.types.doc.permissions.edit = { union: [{ this: true }, { computed: 'owner' }] };
      expect(codes(ir)).to.deep.equal([['IR001', 'types.doc.permissions.edit.union[0]']]);
    });

    it('accepts this on a name that is also a relation', () => {
      const ir = docsIR();
      ir.types.doc.permissions.editor = { union: [{ this: true }, { computed: 'owner' }] };
      expect(validateIR(ir)).to.deep.equal([]);
    });
  });

  describe('IR002 subject type not allowed', () => {
    it('reports a subject set naming no relation and a wildcard subject set', () => {
      const ir = docsIR();
      ir.types.doc.relations.banned.allowed = ['group#owner', 'group#member:*'];
      expect(codes(ir)).to.deep.equal([
        ['IR002', 'types.doc.relations.banned.allowed[0]'],
        ['IR002', 'types.doc.relations.banned.allowed[1]'],
      ]);
    });

    it('reports a subject set on a column relation and a tupleset with no object type', () => {
      const ir = docsIR();
      ir.types.doc.relations.owner.allowed = ['user', 'group#member'];
      ir.types.doc.relations.banned.allowed = ['agent'];
      ir.types.doc.permissions.x = { tupleToUserset: { tupleset: 'banned', computed: 'view' } };
      expect(codes(ir)).to.deep.equal([
        ['IR002', 'types.doc.relations.owner.allowed[1]'],
        ['IR002', 'types.doc.permissions.x'],
      ]);
    });
  });

  describe('IR003 rewrite cycle with no stored base', () => {
    it('reports every node of a computed cycle that nothing grounds', () => {
      const ir = docsIR();
      ir.types.doc.permissions.a = { computed: 'b' };
      ir.types.doc.permissions.b = { intersection: [{ computed: 'a' }, { computed: 'owner' }] };
      expect(codes(ir)).to.deep.equal([
        ['IR003', 'types.doc.permissions.a'],
        ['IR003', 'types.doc.permissions.b'],
      ]);
    });

    it('accepts a cycle with a stored base and recursion through a tupleset', () => {
      const ir = docsIR();
      ir.types.doc.permissions.a = { union: [{ computed: 'b' }, { computed: 'owner' }] };
      ir.types.doc.permissions.b = { computed: 'a' };
      ir.types.folder.relations.parent.allowed = ['$global', 'folder'];
      ir.types.$global.permissions.view = { computed: 'admin' };
      ir.types.folder.permissions.view = { union: [{ computed: 'viewer' }, { tupleToUserset: { tupleset: 'parent', computed: 'view' } }] };
      expect(validateIR(ir)).to.deep.equal([]);
    });
  });

  describe('IR004 caveat parameter type mismatch', () => {
    it('reports an unknown caveat on a rewrite and on an allowed subject type', () => {
      const ir = docsIR();
      ir.types.doc.permissions.publish = { caveat: 'missing', of: { computed: 'edit' } };
      ir.types.doc.relations.banned.allowed = [{ type: 'user', caveat: 'gone' }];
      expect(codes(ir)).to.deep.equal([
        ['IR004', 'types.doc.relations.banned.allowed[0]'],
        ['IR004', 'types.doc.permissions.publish'],
      ]);
    });

    it('reports undeclared attributes, wrong literal types and wrong operators', () => {
      const ir = docsIR();
      ir.caveats.bad = {
        params: { 'resource.size': 'int', 'resource.flag': 'bool', 'env.ip': 'ipaddress' },
        expr: { any: [{ attr: 'resource.owner', eq: 'x' }, { attr: 'resource.size', eq: 'big' }, { attr: 'resource.flag', lt: 'x' }, { attr: 'env.ip', like: '10.%' }, { attr: 'resource.size', in: [1, 2.5] }] },
      };
      expect(validateIR(ir).map((d) => d.message)).to.deep.equal([
        'bad: resource.owner is not a parameter',
        'bad: resource.size (int) eq "big"',
        'bad: lt does not apply to resource.flag (bool)',
        'bad: like does not apply to env.ip (ipaddress)',
        'bad: resource.size (int) in [1,2.5]',
      ]);
    });

    it('checks refs against the parameter types and accepts null tests on any type', () => {
      const ir = docsIR();
      ir.caveats.refs = {
        params: { 'resource.region': 'string', 'principal.attributes.regions': 'list<string>', 'principal.attributes.level': 'int', 'resource.tags': 'list<string>' },
        expr: { all: [{ attr: 'resource.region', in: { ref: 'principal.attributes.regions' } }, { attr: 'resource.region', eq: { ref: 'principal.attributes.level' } }, { attr: 'resource.tags', null: false }] },
      };
      expect(validateIR(ir).map((d) => d.message)).to.deep.equal(['refs: resource.region (string) eq principal.attributes.level (int)']);
    });

    it('reports a condition that does not parse', () => {
      const ir = docsIR();
      ir.caveats.broken = { params: {}, expr: { attr: 'resource.x', between: 1 } };
      expect(codes(ir)).to.deep.equal([['IR004', 'caveats.broken']]);
    });
  });

  describe('IR005 permission bound to a missing relation', () => {
    it('reports a missing type and a missing relation', () => {
      const ir = docsIR();
      ir.permissions['invoice:read'] = { type: 'invoice', relation: 'read', list: false, source: { origin: 'test' } };
      ir.permissions['doc:delete'] = { type: 'doc', relation: 'delete', list: false, source: { origin: 'test' } };
      ir.types.other = { relations: { member: { allowed: ['user'], source: rebac } }, permissions: {} };
      expect(codes(ir)).to.deep.equal([
        ['IR005', 'permissions.invoice:read'],
        ['IR005', 'permissions.doc:delete'],
      ]);
    });
  });
});
