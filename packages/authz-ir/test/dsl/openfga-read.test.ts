import 'mocha';
import { expect } from 'chai';
import { readFileSync } from 'node:fs';

import { OpenFgaParseError, canonicalize, irToRebacConfig, readOpenFga, validateIR, writeOpenFga } from '../../src/index.js';
import type { PolicyIR } from '../../src/index.js';
import { docsIR } from '../fixtures/docs.js';

const impact = (): PolicyIR => JSON.parse(readFileSync(new URL('../fixtures/impact-3-3.ir.json', import.meta.url), 'utf8')) as PolicyIR;

const FOREIGN = `model
  schema 1.1

type user
type group
  relations
    define member: [user, group#member]
type folder
  relations
    define parent: [folder]
    define owner: [user]
    define viewer: [user, group#member] or owner or viewer from parent
type doc
  relations
    define parent: [folder]
    define editor: [user]
    define banned: [user]
    define can_read: (editor or viewer from parent) but not banned
`;

describe('readOpenFga', () => {
  it('round-trips what writeOpenFga writes, exactly', () => {
    for (const ir of [docsIR(), impact()]) expect(canonicalize(readOpenFga(writeOpenFga(ir).dsl))).to.equal(canonicalize(ir));
  });

  it('reads a foreign OpenFGA model: type restrictions, this, from, or, and, but not', () => {
    const ir = readOpenFga(FOREIGN);
    expect(ir.types.folder.relations.viewer).to.deep.equal({ allowed: ['user', 'group#member'], source: { kind: 'tuples', store: 'authz_rebac_tuple' } });
    expect(ir.types.folder.permissions.viewer).to.deep.equal({ union: [{ this: true }, { computed: 'owner' }, { tupleToUserset: { tupleset: 'parent', computed: 'viewer' } }] });
    expect(ir.types.doc.permissions.can_read).to.deep.equal({ exclusion: { base: { union: [{ computed: 'editor' }, { tupleToUserset: { tupleset: 'parent', computed: 'viewer' } }] }, subtract: { computed: 'banned' } } });
    expect(Object.keys(ir.types)).to.deep.equal(['user', 'group', 'folder', 'doc']);
  });

  it('refuses CEL conditions it has no JSON for and lines it cannot read', () => {
    expect(() => readOpenFga('model\n  schema 1.1\ncondition c(x: int) {\n  x > 1\n}\n')).to.throw(OpenFgaParseError, /line 3: condition c has no # spina:caveat/);
    expect(() => readOpenFga('model\n  schema 1.1\ntype doc\n  relations\n    define a: b or c and d\n')).to.throw(OpenFgaParseError, /line 5: unexpected "and"/);
  });
});

describe('irToRebacConfig', () => {
  it('turns a foreign model into authz.rebac namespaces and lists what ReBAC cannot hold', () => {
    const ir = readOpenFga(FOREIGN);
    ir.permissions['doc:read'] = { type: 'doc', relation: 'can_read', list: true, source: { origin: 'import' } };
    const config = irToRebacConfig(ir);
    expect(config.namespaces.doc).to.deep.equal({ relations: { parent: ['folder'], editor: ['user'], banned: ['user'] }, permissions: { can_read: { exclusion: { base: { union: ['editor', 'parent->viewer'] }, subtract: 'banned' } } } });
    expect(config.permissions).to.deep.equal({ 'doc:read': 'doc#can_read' });
    expect(config.problems).to.deep.equal(['folder#viewer: a name that is both a relation and a permission']);
  });

  it('names $global global and reports caveats, wildcards and priority chains', () => {
    const config = irToRebacConfig(docsIR());
    expect(config.namespaces.global.relations).to.deep.equal({ admin: ['user'] });
    expect(config.namespaces.folder.relations?.parent).to.deep.equal(['global']);
    expect(config.problems).to.deep.equal(['folder#viewer: ReBAC holds no wildcard or conditional subject "user:*"', 'doc#editor: ReBAC holds no wildcard or conditional subject {"type":"user","caveat":"office_hours"}', 'doc#publish: ReBAC has no caveat rewrite']);
    expect(validateIR(readOpenFga(FOREIGN))).to.deep.equal([]);
  });
});
