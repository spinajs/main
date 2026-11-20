import 'mocha';
import { expect } from 'chai';

import { CaveatEvaluator, GLOBAL_OBJECT, IREvaluator, MemoryTupleSource, Walker, admits, parseSubjectTypeRef, subjectsOf } from '../../src/index.js';
import type { CheckResult, EvalInput, ExplainNode, IREvaluatorOptions, PolicyIR, PrincipalFacts, RelationDef, Rewrite, SubjectTypeRef, Truth } from '../../src/index.js';
import { docsIR } from '../fixtures/docs.js';

const user = (id: string) => ({ type: 'user', id });
const doc = (id: string) => ({ type: 'doc', id });
const folder = (id: string) => ({ type: 'folder', id });
const group = (id: string) => ({ type: 'group', id });
const members = (id: string) => ({ type: 'group', id, relation: 'member' });

/** f1 under $global, d1 in f1; group g1 (with nested g2) views f1; u1 edits d1, u2 wrote d1, u3 is in g2, u9 is a global admin. */
function world(ir: PolicyIR = docsIR()): MemoryTupleSource {
  return new MemoryTupleSource(ir)
    .add(folder('f1'), 'parent', GLOBAL_OBJECT)
    .add(folder('f2'), 'parent', GLOBAL_OBJECT)
    .add(folder('f1'), 'viewer', members('g1'))
    .add(group('g1'), 'member', members('g2'))
    .add(group('g2'), 'member', user('u3'))
    .add(doc('d1'), 'editor', user('u1'))
    .add(GLOBAL_OBJECT, 'admin', user('u9'))
    .setColumn('Doc', 'folder_id', doc('d1'), folder('f1'))
    .setColumn('Doc', 'author_id', doc('d1'), user('u2'))
    .setColumn('Doc', 'folder_id', doc('d2'), folder('f2'));
}

async function truth(input: Partial<EvalInput> & { principal: EvalInput['principal'] }, source = world(), ir = docsIR(), options?: IREvaluatorOptions): Promise<Truth> {
  return (await new IREvaluator(ir, source, options).check({ permission: 'doc:read', resource: doc('d1'), ...input })).truth;
}

describe('IREvaluator.check', () => {
  it('follows stored tuples, columns, nested subject sets and tuple-to-userset', async () => {
    expect(await truth({ principal: user('u1'), permission: 'doc:update' })).to.equal('allow');
    expect(await truth({ principal: user('u2'), permission: 'doc:update' })).to.equal('allow');
    expect(await truth({ principal: user('u3'), permission: 'doc:update' })).to.equal('deny');
    expect(await truth({ principal: user('u3') })).to.equal('allow');
    expect(await truth({ principal: user('u4') })).to.equal('deny');
  });

  it('reaches every object from a $global role through the parent chain', async () => {
    expect(await truth({ principal: user('u9') })).to.equal('allow');
    expect(await truth({ principal: user('u9'), permission: 'folder:read', resource: folder('f2') })).to.equal('allow');
    expect(await truth({ principal: user('u9'), permission: 'doc:read', resource: doc('d3') })).to.equal('deny');
  });

  it('subtracts an exclusion and matches the public wildcard', async () => {
    const source = world().add(doc('d1'), 'banned', user('u3')).add(folder('f2'), 'viewer', { type: 'user', id: '*' });
    expect(await truth({ principal: user('u3') }, source)).to.equal('deny');
    expect(await truth({ principal: user('u7'), resource: doc('d2') }, source)).to.equal('allow');
    expect(await truth({ principal: { type: 'agent', id: 'u7' }, resource: doc('d2') }, source)).to.equal('deny');
  });

  it('denies an unbound permission and a resource of another type', async () => {
    expect(await truth({ principal: user('u1'), permission: 'doc:delete' })).to.equal('deny');
    expect(await truth({ principal: user('u1'), resource: folder('f1') })).to.equal('deny');
    let error: unknown;
    try {
      await new IREvaluator(docsIR(), world()).check({ principal: user('u1'), permission: 'doc:read', resource: { type: 'doc' } });
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(TypeError);
  });

  it('ends a membership cycle with deny, as ReBAC does', async () => {
    const source = world().add(group('g2'), 'member', members('g1'));
    expect(await truth({ principal: user('u4') }, source)).to.equal('deny');
    expect(await truth({ principal: user('u3') }, source)).to.equal('allow');
  });

  it('answers unknown past maxDepth and maxCalls', async () => {
    const result = await new IREvaluator(docsIR(), world(), { maxDepth: 1 }).check({ principal: user('u3'), permission: 'folder:read', resource: folder('f1') });
    expect(result.truth).to.equal('unknown');
    expect(JSON.stringify(result.tree)).to.contain('maxDepth 1 at group:g2#member');
    expect(await truth({ principal: user('u3') }, world(), docsIR(), { maxCalls: 3 })).to.equal('unknown');
    expect(await truth({ principal: user('u1') }, world(), docsIR(), { maxDepth: 1 })).to.equal('allow');
  });

  it('keeps unknown through an exclusion: unknown base, or a subtract that might hold', async () => {
    const ir = docsIR();
    ir.types.doc.permissions.view = { exclusion: { base: { union: [{ computed: 'edit' }, { opaque: 'custom' }] }, subtract: { computed: 'banned' } } };
    expect(await truth({ principal: user('u4') }, world(), ir)).to.equal('unknown');
    ir.types.doc.permissions.view = { exclusion: { base: { computed: 'edit' }, subtract: { opaque: 'custom' } } };
    expect(await truth({ principal: user('u1') }, world(), ir)).to.equal('unknown');
    expect(await truth({ principal: user('u4') }, world(), ir)).to.equal('deny');
  });

  it('decides priority chains first-applicable, in Kleene logic', async () => {
    const ir = docsIR();
    ir.types.doc.permissions.view = {
      priority: [
        { when: { computed: 'banned' }, then: 'deny' },
        { when: { computed: 'edit' }, then: 'permit' },
      ],
    };
    const source = world().add(doc('d1'), 'banned', user('u2'));
    expect(await truth({ principal: user('u1') }, source, ir)).to.equal('allow');
    expect(await truth({ principal: user('u2') }, source, ir)).to.equal('deny');
    expect(await truth({ principal: user('u4') }, source, ir)).to.equal('deny');
    ir.types.doc.permissions.view = { priority: [{ when: { opaque: 'x' }, then: 'deny' }, ...ir.types.doc.permissions.view.priority] };
    expect(await truth({ principal: user('u1') }, source, ir)).to.equal('unknown');
    expect(await truth({ principal: user('u4') }, source, ir)).to.equal('deny');
  });

  it('explains the decision as a { label, truth, children, source } tree', async () => {
    const { tree } = await new IREvaluator(docsIR(), world()).check({ principal: user('u3'), permission: 'doc:read', resource: doc('d1') });
    expect(tree).to.include({ label: 'user:u3 doc:read doc:d1', truth: 'allow', source: 'permissions.doc:read' });
    const view = tree.children[0];
    expect(view).to.include({ label: 'doc:d1#view', truth: 'allow', source: 'types.doc.permissions.view' });
    const text = JSON.stringify(tree);
    expect(text).to.contain('parent->view').and.to.contain('folder:f1#viewer@group:g1#member').and.to.contain('group:g2#member@user:u3');
  });
});

describe('IREvaluator.check principal narrowing (G6)', () => {
  it('applies the ceiling: permission globs, expiry, resources and roles', async () => {
    const at = new Date('2026-11-04T10:00:00Z');
    expect(await truth({ principal: { ...user('u3'), ceiling: { permissions: ['folder:*'] } } })).to.equal('deny');
    expect(await truth({ principal: { ...user('u3'), ceiling: { permissions: ['doc:*'] } } })).to.equal('allow');
    expect(await truth({ principal: { ...user('u3'), ceiling: { expiresAt: '2026-11-04T09:00:00Z' } }, at })).to.equal('deny');
    expect(await truth({ principal: { ...user('u3'), ceiling: { expiresAt: '2026-11-04T11:00:00Z' } }, at })).to.equal('allow');
    expect(await truth({ principal: { ...user('u9'), ceiling: { resources: [folder('f1')] } } })).to.equal('allow');
    expect(await truth({ principal: { ...user('u9'), ceiling: { resources: [folder('f1')] } }, resource: doc('d2') })).to.equal('deny');
    expect(await truth({ principal: { ...user('u9'), ceiling: { resources: [{ type: '$global' }] } }, resource: doc('d2') })).to.equal('allow');
    expect(await truth({ principal: { ...user('u9'), ceiling: { roles: [] } } })).to.equal('deny');
    expect(await truth({ principal: { ...user('u9'), ceiling: { roles: ['admin'] } } })).to.equal('allow');
  });

  it('ignores ceilings and delegation the IR does not enforce', async () => {
    const ir = docsIR();
    ir.principal.ceiling = false;
    ir.principal.delegation = false;
    expect(await truth({ principal: { ...user('u3'), ceiling: { permissions: [] } } }, world(ir), ir)).to.equal('allow');
    expect(await truth({ principal: { type: 'agent', id: 'a1', onBehalfOf: user('u3') } }, world(ir), ir)).to.equal('deny');
  });

  it('intersects an agent with its delegate, or runs as the delegate under inherit', async () => {
    const agent = { type: 'agent', id: 'a1', onBehalfOf: user('u3') };
    expect(await truth({ principal: agent })).to.equal('deny');
    expect(await truth({ principal: agent }, world().add(folder('f1'), 'viewer', { type: 'agent', id: 'a1' }), docsIR(), undefined)).to.equal('deny');
    const ir = docsIR();
    ir.types.folder.relations.viewer.allowed.push('agent');
    expect(await truth({ principal: agent }, world(ir).add(folder('f1'), 'viewer', { type: 'agent', id: 'a1' }), ir)).to.equal('allow');
    expect(await truth({ principal: { ...agent, delegation: 'inherit' } })).to.equal('allow');
    expect(await truth({ principal: { ...agent, delegation: 'inherit', ceiling: { permissions: ['folder:*'] } } })).to.equal('deny');
    expect(await truth({ principal: { type: 'agent', id: 'a1', onBehalfOf: { type: 'system', id: 'system' }, delegation: 'inherit' } })).to.equal('deny');
  });
});

const rebac = { kind: 'tuples', store: 'authz_rebac_tuple' } as const;
const note = (id: string) => ({ type: 'note', id });

/** `note` with stored `viewer`, `banned`, `parent` and `guests` beside the given permissions, each bound as `note:<name>`. */
function noteIR(permissions: Record<string, Rewrite>): PolicyIR {
  return {
    version: 1,
    types: {
      user: { relations: {}, permissions: {} },
      folder: { relations: { viewer: { allowed: ['user'], source: rebac } }, permissions: {} },
      note: {
        relations: {
          viewer: { allowed: ['user'], source: rebac },
          banned: { allowed: ['user'], source: rebac },
          parent: { allowed: ['folder'], source: rebac },
          guests: { allowed: ['ghost#member'], source: rebac },
        },
        permissions,
      },
    },
    permissions: Object.fromEntries(Object.keys(permissions).map((name) => [`note:${name}`, { type: 'note', relation: name, list: false, source: { origin: 'test' } }])),
    caveats: {
      evening: { params: { 'env.hour': 'int' }, expr: { attr: 'env.hour', gte: 18 } },
      night: { params: { 'env.hour': 'int' }, expr: { attr: 'env.hour', lt: 6 } },
    },
    combine: { default: { algorithm: 'deny-overrides' } },
    principal: { ceiling: true, delegation: false, ancestry: 'parent', roles: { viewer: [{ type: 'note', relation: 'viewer' }] } },
    opaque: [],
  };
}

/** u1 views n1 and its folder f1, u2 is banned from n1, and n1's guests are members of a group whose type the IR lacks. */
const notes = (ir: PolicyIR): MemoryTupleSource =>
  new MemoryTupleSource(ir)
    .add(note('n1'), 'viewer', user('u1'))
    .add(note('n1'), 'banned', user('u2'))
    .add(note('n1'), 'parent', folder('f1'))
    .add(folder('f1'), 'viewer', user('u1'))
    .add(note('n1'), 'guests', { type: 'ghost', id: 'g1', relation: 'member' });

/** Checks `note:<permission>` on n1 at 20:00. */
function checkNote(permissions: Record<string, Rewrite>, permission: string, extra: { options?: IREvaluatorOptions; principal?: PrincipalFacts } = {}): Promise<CheckResult> {
  const ir = noteIR(permissions);
  return new IREvaluator(ir, notes(ir), extra.options).check({ principal: extra.principal ?? user('u1'), permission: `note:${permission}`, resource: note('n1'), context: { env: { hour: 20 } } });
}

/** The explain tree as indented `label [truth] source` lines. */
const outline = (n: ExplainNode, depth = 0): string[] => [`${'  '.repeat(depth)}${n.label} [${n.truth}] ${n.source}`, ...n.children.flatMap((c) => outline(c, depth + 1))];

/** The walk under the root node; a ceiling node, when there is one, comes before it. */
const walked = (tree: ExplainNode): ExplainNode => tree.children[tree.children.length - 1];

describe('IREvaluator.check explain tree and memo', () => {
  const viewer = ['note:n1#viewer [allow] types.note.relations.viewer', '  union [allow] union', '    note:n1#viewer@user:u1 [allow] tuple', '      note:n1#viewer@user:u1 [allow] tuples'];
  const banned = ['note:n1#banned [deny] types.note.relations.banned', '  union [deny] union'];
  const under = (lines: string[]) => lines.map((line) => `  ${line}`);
  const rows: Array<{ kind: string; x: Rewrite; truth: Truth; explain: string[]; options?: IREvaluatorOptions; principal?: PrincipalFacts }> = [
    { kind: 'a stored relation', x: { computed: 'viewer' }, truth: 'allow', explain: viewer },
    { kind: 'an exclusion', x: { exclusion: { base: { computed: 'viewer' }, subtract: { computed: 'banned' } } }, truth: 'allow', explain: ['exclusion [allow] exclusion', ...under(viewer), ...under(banned)] },
    { kind: 'an exclusion whose base denies', x: { exclusion: { base: { computed: 'banned' }, subtract: { computed: 'viewer' } } }, truth: 'deny', explain: ['exclusion [deny] exclusion', ...under(banned)] },
    { kind: 'an intersection up to its first deny', x: { intersection: [{ computed: 'viewer' }, { computed: 'banned' }, { opaque: 'never asked' }] }, truth: 'deny', explain: ['intersection [deny] intersection', ...under(viewer), ...under(banned)] },
    {
      kind: 'a priority chain up to the entry that always applies',
      x: { priority: [{ when: { intersection: [] }, then: 'permit' }, { when: { computed: 'viewer' }, then: 'deny' }] },
      truth: 'allow',
      explain: ['priority [allow] priority', '  then permit [allow] priority', '    intersection [allow] intersection'],
    },
    { kind: 'an opaque rewrite', x: { opaque: 'custom' }, truth: 'unknown', explain: ['opaque custom [unknown] opaque'] },
    { kind: 'a relation the type lacks', x: { computed: 'nope' }, truth: 'deny', explain: ['note:n1#nope [deny] types.note.relations.nope', '  no such relation [deny] types.note'] },
    {
      kind: 'a subject set of a type the IR lacks',
      x: { computed: 'guests' },
      truth: 'deny',
      explain: ['note:n1#guests [deny] types.note.relations.guests', '  union [deny] union', '    note:n1#guests@ghost:g1#member [deny] tuple', '      ghost:g1#member [deny] types.ghost.relations.member', '        no such relation [deny] types.ghost'],
    },
    { kind: '{ this: true } on a permission without stored tuples', x: { this: true }, truth: 'deny', explain: ['x is not stored [deny] types.note'] },
    { kind: 'a caveat that fails', x: { caveat: 'night', of: { computed: 'viewer' } }, truth: 'deny', explain: ['with night [deny] caveat', '  caveat night [deny] caveats.night'] },
    { kind: 'a caveat that holds', x: { caveat: 'evening', of: { intersection: [] } }, truth: 'allow', explain: ['with evening [allow] caveat', '  caveat evening [allow] caveats.evening', '  intersection [allow] intersection'] },
    {
      kind: 'a tuple-to-userset',
      x: { tupleToUserset: { tupleset: 'parent', computed: 'viewer' } },
      truth: 'allow',
      explain: ['parent->viewer [allow] tupleToUserset', '  note:n1#parent@folder:f1 [allow] tuple', '    folder:f1#viewer [allow] types.folder.relations.viewer', '      union [allow] union', '        folder:f1#viewer@user:u1 [allow] tuple', '          folder:f1#viewer@user:u1 [allow] tuples'],
    },
    { kind: 'a tuple-to-userset over a relation the type lacks', x: { tupleToUserset: { tupleset: 'nope', computed: 'viewer' } }, truth: 'deny', explain: ['nope is not a tupleset [deny] types.note'] },
    {
      kind: 'a hop past maxDepth',
      x: { tupleToUserset: { tupleset: 'parent', computed: 'viewer' } },
      options: { maxDepth: 0 },
      truth: 'unknown',
      explain: ['parent->viewer [unknown] tupleToUserset', '  note:n1#parent@folder:f1 [unknown] tuple', '    maxDepth 0 at folder:f1#viewer [unknown] limit'],
    },
    {
      kind: 'a relation outside the ceiling roles',
      x: { computed: 'viewer' },
      principal: { ...user('u1'), ceiling: { roles: [] } },
      truth: 'deny',
      explain: ['note:n1#viewer [deny] types.note.relations.viewer', '  viewer is outside the ceiling roles [deny] principal.ceiling'],
    },
  ];

  for (const row of rows)
    it(`explains ${row.kind}, and answers it from the memo when asked again at the same depth`, async () => {
      // An intersection goes on past an allow and a union past a deny, so both copies of x and of y are asked for.
      const junction = row.truth === 'allow' ? 'intersection' : 'union';
      const twice = (name: string): Rewrite => (junction === 'intersection' ? { intersection: [{ computed: name }, { computed: name }] } : { union: [{ computed: name }, { computed: name }] });
      const { truth, tree } = await checkNote({ read: twice('y'), y: twice('x'), x: row.x }, 'read', row);
      const t = row.truth;
      expect(truth).to.equal(t);
      expect(outline(walked(tree))).to.deep.equal([
        `note:n1#read [${t}] types.note.permissions.read`,
        `  ${junction} [${t}] ${junction}`,
        `    note:n1#y [${t}] types.note.permissions.y`,
        `      ${junction} [${t}] ${junction}`,
        `        note:n1#x [${t}] types.note.permissions.x`,
        ...row.explain.map((line) => `          ${line}`),
        `        note:n1#x [${t}] memo`,
        `    note:n1#y [${t}] memo`,
      ]);
    });
});

describe('IREvaluator.check cycles', () => {
  it('denies a cycle with no way out, and explains where it closed', async () => {
    const { truth, tree } = await checkNote({ a: { union: [{ computed: 'b' }] }, b: { intersection: [{ computed: 'a' }] } }, 'a');
    expect(truth).to.equal('deny');
    expect(outline(walked(tree))).to.deep.equal(['note:n1#a [deny] types.note.permissions.a', '  union [deny] union', '    note:n1#b [deny] types.note.permissions.b', '      intersection [deny] intersection', '        note:n1#a [deny] cycle']);
  });

  const edges: Array<{ through: string; b: Rewrite; truth: Truth }> = [
    { through: 'a union', b: { union: [{ computed: 'a' }] }, truth: 'allow' },
    { through: 'an exclusion', b: { exclusion: { base: { intersection: [] }, subtract: { computed: 'a' } } }, truth: 'deny' },
    { through: 'a priority chain', b: { priority: [{ when: { computed: 'a' }, then: 'deny' }, { when: { intersection: [] }, then: 'permit' }] }, truth: 'deny' },
  ];
  for (const e of edges)
    it(`asks again, off the cycle, for a node the cycle denied, through ${e.through}`, async () => {
      // `read` asks for `b` twice: inside `a`, where the cycle back to `a` denies it, and then with `a` off the path.
      const { truth } = await checkNote({ read: { intersection: [{ computed: 'a' }, { computed: 'b' }] }, a: { union: [{ computed: 'b' }, { computed: 'viewer' }] }, b: e.b }, 'read');
      expect(truth).to.equal(e.truth);
    });
});

describe('IREvaluator.check limits', () => {
  it('allows within exactly maxCalls node visits and answers unknown one below, naming the node it stopped at', async () => {
    const at = (maxCalls: number) => checkNote({ x: { computed: 'viewer' } }, 'x', { options: { maxCalls } });
    expect((await at(2)).truth).to.equal('allow');
    const below = await at(1);
    expect(below.truth).to.equal('unknown');
    expect(outline(below.tree)).to.deep.equal(['user:u1 note:x note:n1 [unknown] permissions.note:x', '  maxCalls 1 exceeded at note:n1#viewer [unknown] limit']);
  });

  it('records the first node past maxDepth in Walker.tooDeep', async () => {
    const ir = noteIR({ x: { union: [{ tupleToUserset: { tupleset: 'parent', computed: 'viewer' } }, { computed: 'guests' }] } });
    const input = { principal: user('u1'), permission: 'note:x', resource: note('n1'), at: new Date() };
    const walker = new Walker({ ir, tuples: notes(ir), caveats: new CaveatEvaluator(ir), input, maxDepth: 0, maxCalls: 100, blocked: new Set() });
    expect((await walker.node(note('n1'), 'x', 0)).truth).to.equal('unknown');
    expect(walker.tooDeep).to.equal('folder:f1#viewer');
  });
});

describe('IREvaluator.check subjects and relation sources', () => {
  it('admits a subject only through an allowed type of its own kind: direct, wildcard, subject set, caveated', () => {
    const allowed = (...refs: SubjectTypeRef[]) => refs.map(parseSubjectTypeRef);
    const anyone = { type: 'user', id: '*' };
    expect(admits(allowed('user'), user('u1'))).to.equal(true);
    expect(admits(allowed('user:*'), user('u1'))).to.equal(false);
    expect(admits(allowed('user:*'), anyone)).to.equal(true);
    expect(admits(allowed('user'), anyone)).to.equal(false);
    expect(admits(allowed('group#member'), members('g1'))).to.equal(true);
    expect(admits(allowed('group#member'), group('g1'))).to.equal(false);
    expect(admits(allowed('group#owner'), members('g1'))).to.equal(false);
    expect(admits(allowed('group'), members('g1'))).to.equal(false);
    expect(admits(allowed({ type: 'user', caveat: 'night' }), user('u1'))).to.equal(false);
    expect(admits(allowed({ type: 'user', caveat: 'night' }), { ...user('u1'), caveat: { name: 'night' } })).to.equal(true);
  });

  it('reads a relation by its source: a NULL column, the object itself, stored ancestors, the $global root', async () => {
    const source = new MemoryTupleSource().add(folder('f1'), 'parent', GLOBAL_OBJECT);
    const ancestor = (via: string): RelationDef => ({ allowed: ['$global'], source: { kind: 'ancestor', via } });
    expect(await subjectsOf(source, note('n1'), 'owner', { allowed: ['user'], source: { kind: 'column', model: 'Note', column: 'owner_id' } })).to.deep.equal([]);
    expect(await subjectsOf(source, user('u1'), 'me', { allowed: ['user'], source: { kind: 'self' } })).to.deep.equal([user('u1')]);
    expect(await subjectsOf(source, folder('f1'), 'parent', ancestor('folder'))).to.deep.equal([GLOBAL_OBJECT]);
    expect(await subjectsOf(source, folder('f2'), 'parent', ancestor('folder'))).to.deep.equal([]);
    expect(await subjectsOf(source, folder('f2'), 'parent', ancestor('$global'))).to.deep.equal([GLOBAL_OBJECT]);
    expect(await subjectsOf(source, GLOBAL_OBJECT, 'parent', ancestor('$global'))).to.deep.equal([]);
  });

  it('reads the stored tuples of a permission that shares its name with a relation through { this: true }', async () => {
    expect((await checkNote({ viewer: { this: true } }, 'viewer')).truth).to.equal('allow');
  });

  it('follows a tupleset only to admitted objects of a known type, never to a subject set or a wildcard', async () => {
    const ir = noteIR({ x: { tupleToUserset: { tupleset: 'links', computed: 'viewer' } } });
    ir.types.note.relations.links = { allowed: ['folder', 'folder#viewer', 'folder:*', 'ghost'], source: rebac };
    const tuples = notes(ir)
      .add(folder('*'), 'viewer', user('u1'))
      .add(note('n1'), 'links', { type: 'folder', id: 'f1', relation: 'viewer' })
      .add(note('n1'), 'links', { type: 'folder', id: '*' })
      .add(note('n1'), 'links', { type: 'ghost', id: 'g1' })
      .add(note('n1'), 'links', user('u1'));
    const { truth, tree } = await new IREvaluator(ir, tuples).check({ principal: user('u1'), permission: 'note:x', resource: note('n1') });
    expect(truth).to.equal('deny');
    expect(outline(walked(tree))).to.deep.equal(['note:n1#x [deny] types.note.permissions.x', '  links->viewer [deny] tupleToUserset']);
  });
});
