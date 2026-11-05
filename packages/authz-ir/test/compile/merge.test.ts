import 'mocha';
import { expect } from 'chai';
import type { AuthorizationModel } from '@spinajs/authz';

import { GLOBAL_OBJECT, IREvaluator, MemoryTupleSource, compileModels, mergeFragments, validateIR } from '../../src/index.js';
import type { IRFragment } from '../../src/index.js';

const tuples = { kind: 'tuples', store: 't' } as const;
const source = { origin: 'test' };

const rebac: IRFragment = {
  model: 'rebac',
  types: {
    org: { relations: { member: { allowed: ['user'], source: tuples } }, permissions: {} },
    doc: { relations: { parent: { allowed: ['org'], source: { kind: 'column', model: 'Doc', column: 'org_id' } }, viewer: { allowed: ['user'], source: tuples } }, permissions: { view: { union: [{ computed: 'viewer' }, { tupleToUserset: { tupleset: 'parent', computed: 'member' } }] } } },
  },
  permissions: { 'doc:read': { type: 'doc', permit: 'view', list: true, source } },
};

const rbac: IRFragment = {
  model: 'rbac',
  types: {
    $global: { relations: { admin: { allowed: ['user'], source: tuples } }, permissions: { can_doc_read: { computed: 'admin' } } },
    org: { relations: {}, permissions: { can_doc_read: { tupleToUserset: { tupleset: 'parent', computed: 'can_doc_read' } } } },
    doc: { relations: { blocked: { allowed: ['user'], source: tuples } }, permissions: { can_doc_read: { tupleToUserset: { tupleset: 'parent', computed: 'can_doc_read' } } } },
  },
  permissions: { 'doc:read': { type: 'doc', permit: 'can_doc_read', deny: 'blocked', source }, 'doc:delete': { type: 'doc', permit: 'can_doc_read', source } },
  roles: { admin: [{ type: '$global', relation: 'admin' }] },
};

describe('mergeFragments', () => {
  it('adds $global, closes root types at it and binds a lone permitting model directly', () => {
    const { ir, conflicts } = mergeFragments([rebac]);
    expect(conflicts).to.deep.equal([]);
    expect(Object.keys(ir.types)).to.deep.equal(['$global', 'org', 'doc']);
    expect(ir.types.org.relations.parent).to.deep.equal({ allowed: ['$global'], source: { kind: 'ancestor', via: '$global' } });
    expect(ir.types.doc.relations.parent.source.kind).to.equal('column');
    expect(ir.types.$global.relations).to.deep.equal({});
    expect(ir.permissions['doc:read']).to.deep.equal({ type: 'doc', relation: 'view', list: true, source });
    expect(validateIR(ir)).to.deep.equal([]);
  });

  it('combines several models deny-overrides, unions roles and lists models without a fragment as opaque', () => {
    const { ir, conflicts } = mergeFragments([rbac, rebac], { models: ['rebac', 'rbac', 'custom'] });
    expect(conflicts).to.deep.equal([]);
    expect(ir.permissions['doc:read']).to.deep.equal({ type: 'doc', relation: 'perm_doc_read', list: true, source });
    expect(ir.types.doc.permissions.perm_doc_read).to.deep.equal({ exclusion: { base: { union: [{ computed: 'view' }, { computed: 'can_doc_read' }] }, subtract: { computed: 'blocked' } } });
    expect(ir.permissions['doc:delete'].relation).to.equal('can_doc_read');
    expect(ir.principal.roles).to.deep.equal({ admin: [{ type: '$global', relation: 'admin' }] });
    expect(ir.opaque).to.deep.equal([{ kind: 'model', name: 'custom' }]);
    expect(validateIR(ir)).to.deep.equal([]);
  });

  it('binds a deny-only permission to a relation that never permits', () => {
    const deny: IRFragment = { model: 'abac', types: { doc: { relations: { frozen: { allowed: ['user:*'], source: tuples } }, permissions: {} } }, permissions: { 'doc:update': { type: 'doc', deny: 'frozen', source } } };
    const { ir } = mergeFragments([rebac, deny]);
    expect(ir.types.doc.permissions.perm_doc_update).to.deep.equal({ priority: [] });
  });

  it('keeps the first of two different definitions and reports the conflict', () => {
    const other: IRFragment = { model: 'other', types: { doc: { relations: { viewer: { allowed: ['group#member'], source: tuples } }, permissions: {} } }, permissions: { 'doc:read': { type: 'org', permit: 'member', source } } };
    const { ir, conflicts } = mergeFragments([rebac, other]);
    expect(ir.types.doc.relations.viewer.allowed).to.deep.equal(['user']);
    expect(conflicts.map((c) => c.path)).to.deep.equal(['types.doc.relations.viewer', 'permissions.doc:read']);
  });

  it('evaluates a $global grant down the closed chain', async () => {
    const { ir } = mergeFragments([rbac, rebac]);
    const data = new MemoryTupleSource(ir).add(GLOBAL_OBJECT, 'admin', { type: 'user', id: 'a' }).setColumn('Doc', 'org_id', { type: 'doc', id: 'd1' }, { type: 'org', id: 'o1' });
    const ev = new IREvaluator(ir, data);
    expect((await ev.check({ principal: { type: 'user', id: 'a' }, permission: 'doc:read', resource: { type: 'doc', id: 'd1' } })).truth).to.equal('allow');
    expect((await ev.check({ principal: { type: 'user', id: 'b' }, permission: 'doc:read', resource: { type: 'doc', id: 'd1' } })).truth).to.equal('deny');
  });
});

describe('compileModels', () => {
  it('collects the toIR fragments of the models and passes each its context', async () => {
    const seen: string[] = [];
    const models = [
      { name: 'rebac', toIR: (ctx: { config: (p: string) => unknown }) => (seen.push(String(ctx.config('x'))), rebac) },
      { name: 'legacy' },
    ] as unknown as AuthorizationModel[];
    const { ir } = await compileModels(models, (m) => ({ config: <T>(path: string) => `${m.name}.${path}` as T }));
    expect(seen).to.deep.equal(['rebac.x']);
    expect(ir.permissions['doc:read'].relation).to.equal('view');
    expect(ir.opaque).to.deep.equal([{ kind: 'model', name: 'legacy' }]);
  });
});
