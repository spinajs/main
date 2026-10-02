import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import 'mocha';

import { GLOBAL, SYSTEM } from '@spinajs/authz';

import { BEHAVIOUR_FIXTURES, BEHAVIOUR_RULES, FACETS, FakeRbacModel, FakeTupleModel, StaticModel, fixtureDsl, instantiateWorld, mergeFixtures, userPrincipal, validateCase, validateWorld } from '../../src/index.js';
import type { Case, World } from '../../src/index.js';

const { assignment, combine, permit, ref, role, staticModel } = fixtureDsl;

const fixtures = mergeFixtures(BEHAVIOUR_FIXTURES);
const alice = userPrincipal('alice');

describe('behaviour fixture catalogue', () => {
  it('holds the 46 rules of design §17 verbatim', () => {
    const design = readFileSync(new URL('../../../../docs/plans/2026-10-01-authz-v3-design.md', import.meta.url), 'utf8');
    const section = design.slice(design.indexOf('## 17. Behaviour spec'), design.indexOf('## 18.'));
    const rows = [...section.matchAll(/^\| (B\d\d) \| (.*) \|$/gm)].map((m) => [m[1], m[2]]);
    assert.equal(rows.length, 46);
    assert.deepEqual(Object.entries(BEHAVIOUR_RULES), rows);
    for (const f of fixtures.values()) assert.equal(f.rule, BEHAVIOUR_RULES[f.id]);
  });

  it('has the rules of task 4a, each with a part every lane can name', () => {
    assert.deepEqual([...fixtures.keys()].sort(), ['B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08', 'B09', 'B14', 'B17', 'B22', 'B27', 'B29', 'B36', 'B37', 'B39']);
    for (const f of fixtures.values()) {
      const names = f.parts.map((p) => p.name);
      assert.equal(new Set(names).size, names.length, `${f.id}: part names are unique`);
      for (const p of f.parts) {
        assert.match(p.name, /^[A-Za-z][A-Za-z0-9-]*$/, `${f.id}.${p.name}`);
        assert.ok(p.facets.length > 0, `${f.id}.${p.name} needs facets`);
        for (const facet of p.facets) assert.ok(Object.hasOwn(FACETS, facet), `${f.id}.${p.name}: facet ${facet}`);
        assert.ok(p.cases.length > 0 || p.note, `${f.id}.${p.name}: a part without cases says why`);
        const titles = p.cases.map((c) => c.name);
        assert.equal(new Set(titles).size, titles.length, `${f.id}.${p.name}: case names are unique`);
      }
    }
  });

  it('every case world is well-formed and every step reference resolves', () => {
    const problems: string[] = [];
    for (const f of fixtures.values()) for (const p of f.parts) for (const c of p.cases) problems.push(...validateCase(c, p.world).map((x) => `${f.id}.${p.name} ${x}`));
    assert.deepEqual(problems, []);
  });

  it('every world instantiates', () => {
    for (const f of fixtures.values()) for (const p of f.parts) for (const c of p.cases) assert.doesNotThrow(() => instantiateWorld((c.world ?? p.world)!), `${f.id}.${p.name} ${c.name}`);
  });
});

describe('validateWorld and validateCase', () => {
  const good: World = {
    now: new Date(0),
    permissions: ['file:read'],
    principals: { alice },
    combine: combine('deny-overrides', 'm1', 'rbac'),
    models: [staticModel('m1')],
    adapters: [{ types: ['file'], rows: { file: [{ id: 'f1' }] } }],
    rbac: { roles: [role('viewer', ['file:read'])], assignments: [assignment('a1', alice, 'viewer', GLOBAL, { expiresAt: new Date(1) })] },
  };
  const step = (c: Partial<Case>): Case => ({ name: 'c', world: good, steps: [], ...c });

  it('accepts a well-formed world', () => {
    assert.deepEqual(validateWorld(good), []);
  });

  const BROKEN: readonly [string, World, RegExp][] = [
    ['an invalid permission name', { ...good, permissions: ['file:read', 'nope'] }, /permission "nope"/],
    ['a permission declared twice', { ...good, permissions: ['file:read', 'file:read'] }, /declared twice/],
    ['a combine model that is not in the world', { ...good, combine: combine('deny-overrides', 'ghost') }, /model ghost is not in the world/],
    ['an unknown algorithm', { ...good, combine: combine('random' as never, 'm1') }, /unknown algorithm random/],
    ['two kit models with one name', { ...good, models: [staticModel('m1'), staticModel('m1')] }, /two kit models are named m1/],
    ['a type claimed by two adapters', { ...good, adapters: [{ types: ['file'] }, { types: ['file'] }] }, /claimed by 2 adapters/],
    ['a row id twice', { ...good, adapters: [{ types: ['file'], rows: { file: [{ id: 'f1' }, { id: 'f1' }] } }] }, /file:f1 appears twice/],
    ['an assignment of an unknown role', { ...good, rbac: { roles: [], assignments: [assignment('a1', alice, 'viewer')] } }, /unknown role viewer/],
    ['an assignment to an unknown principal', { ...good, rbac: { roles: [role('viewer', [])], assignments: [assignment('a1', userPrincipal('zed'), 'viewer')] } }, /unknown principal user:zed/],
    ['an assignment id twice', { ...good, rbac: { roles: [role('viewer', [])], assignments: [assignment('a1', alice, 'viewer'), assignment('a1', alice, 'viewer')] } }, /assignment a1 appears twice/],
    ['expiry without now', { ...good, now: undefined }, /uses expiry but has no now/],
    ['a domain with an unknown parent', { ...good, domains: { fs: { parent: 'nowhere' } } }, /unknown parent nowhere/],
    ['a domain disabling an unknown model', { ...good, domains: { fs: { disable: ['ghost'] } } }, /disables unknown model ghost/],
    ['an assignment at a scope the world does not know', { ...good, rbac: { roles: [role('viewer', [])], assignments: [assignment('a1', alice, 'viewer', ref('project', 'p9'))] } }, /scope project:p9 is not a node of the world/],
    ['an invalid policy glob', { ...good, abac: { policies: [{ id: 'p', effect: 'permit', permissions: ['**'], source: 't' }] } }, /is not a permission glob/],
  ];

  for (const [what, world, problem] of BROKEN) {
    it(`reports ${what}`, () => {
      const found = validateWorld(world);
      assert.ok(
        found.some((p) => problem.test(p)),
        `${problem} in ${JSON.stringify(found)}`,
      );
    });
  }

  const CHECK = { as: 'alice', permission: 'file:read' } as const;
  const VACUOUS: readonly [string, Partial<Case>, RegExp][] = [
    ['a case that is not a boot case without steps', { steps: [] }, /needs steps/],
    ['a check whose expectation checks nothing', { steps: [{ check: CHECK, expect: {} }] }, /check: the expectation checks nothing/],
    ['an explain whose expectation holds only undefined keys', { steps: [{ explain: CHECK, expect: { allowed: undefined } }] }, /explain: the expectation checks nothing/],
    ['a checkMany with an empty expectation', { steps: [{ checkMany: { as: 'alice', permissions: ['file:read'] }, expect: {} }] }, /checkMany: the expectation checks nothing/],
    ['a checkMany with an empty expectation for a permission', { steps: [{ checkMany: { as: 'alice', permissions: ['file:read'] }, expect: { 'file:read': {} } }] }, /expectation of file:read checks nothing/],
    ['a checkMany expecting a permission it does not request', { steps: [{ checkMany: { as: 'alice', permissions: ['file:read'] }, expect: { 'file:write': { allowed: true } } }] }, /expects file:write, which it does not request/],
    ['a summary with an empty expectation', { steps: [{ summary: { as: 'alice' }, expect: { permissions: [] } }] }, /summary: the expectation checks nothing/],
    ['a calls step without count, atLeast or lastArgs', { steps: [{ calls: { model: 'm1' } }] }, /calls: needs count, atLeast or lastArgs/],
    ['an agree without principals', { steps: [{ agree: { as: [], permissions: ['file:read'], type: 'file' } }] }, /agree: needs at least one principal and one permission/],
    ['an agree without permissions', { steps: [{ agree: { as: ['alice'], permissions: [], type: 'file' } }] }, /agree: needs at least one principal and one permission/],
    ['an agree over a type with no rows', { steps: [{ agree: { as: ['alice'], permissions: ['file:read'], type: 'dir' } }] }, /the world has no rows of type dir/],
    ['a published step without tags or count', { steps: [{ published: { tags: [] } }] }, /published: no tags and no count/],
    ['an orAtCall boot case with no step that expects a throw', { boot: { throws: 'AuthzConfigError', orAtCall: true }, steps: [{ check: CHECK, expect: { allowed: true } }] }, /orAtCall needs a step that expects a throw/],
  ];

  for (const [what, c, problem] of VACUOUS) {
    it(`reports ${what}`, () => {
      const found = validateCase(step(c));
      assert.ok(
        found.some((p) => problem.test(p)),
        `${problem} in ${JSON.stringify(found)}`,
      );
    });
  }

  it('accepts an orAtCall boot case whose nested step expects a throw', () => {
    assert.deepEqual(validateCase(step({ boot: { throws: 'AuthzConfigError', orAtCall: true }, steps: [{ runAs: { as: 'alice', reason: 'x' }, steps: [{ check: CHECK, expect: { throws: 'AuthzConfigError' } }] }] })), []);
  });

  it('lenient mode (boot cases) skips what the boot checks own', () => {
    assert.deepEqual(validateWorld({ ...good, combine: combine('deny-overrides', 'ghost'), models: [staticModel('m1'), staticModel('m1')] }, { lenient: true }), []);
    assert.deepEqual(validateCase(step({ boot: { throws: 'AuthzConfigError' }, world: { ...good, combine: combine('deny-overrides', 'ghost') } })), []);
  });

  it('reports step references that do not resolve', () => {
    const problems = validateCase(
      step({
        steps: [{ check: { as: 'bob', permission: 'file:read' }, expect: { allowed: true } }, { check: { as: 'alice', permission: 'file:read', resource: ref('file', 'f9'), subject: 'row' }, expect: { allowed: true } }, { check: { as: 'alice', permission: 'file:read', domain: 'fs' }, expect: { allowed: true } }, { calls: { model: 'ghost', count: 0 } }, { runAs: { as: 'carol', reason: 'x' }, steps: [{ current: 'dave' }] }, { advance: 1 }],
        world: { ...good, now: undefined, rbac: undefined, combine: combine('deny-overrides', 'm1') },
      }),
    );
    for (const p of [/unknown principal "bob"/, /needs a world row for file:f9/, /unknown domain fs/, /no kit StaticModel ghost/, /unknown principal "carol"/, /unknown principal "dave"/, /the world has no now/]) {
      assert.ok(
        problems.some((x) => p.test(x)),
        `${p} in ${JSON.stringify(problems)}`,
      );
    }
  });
});

describe('instantiateWorld', () => {
  const world: World = {
    now: new Date('2026-10-01T00:00:00Z'),
    permissions: ['file:read'],
    principals: { alice },
    combine: combine('deny-overrides', 'm1', 'rbac', 'rebac'),
    models: [staticModel('m1', { votes: { 'file:read': permit() } }), { kind: 'fake-rbac', roles: { viewer: ['file:read'] }, assignments: [{ subject: alice, role: 'viewer' }] }, { kind: 'fake-tuple', schema: { file: { relations: { viewer: 'user' }, permissions: { view: 'viewer' } } }, permissions: { 'file:read': 'file#view' }, tuples: [{ object: ref('file', 'f1'), relation: 'viewer', subject: alice }] }],
    domains: { fs: { models: [staticModel('m1')] } },
    adapters: [{ types: ['file'], rows: { file: [{ id: 'f1', owner: 'alice' }] } }],
    scopes: [{ nodes: [{ ref: ref('org', 'o1') }] }],
    relations: [{ type: 'file', relation: 'editor', holds: () => true }],
  };

  it('builds fresh kit fakes from the specs on every call', async () => {
    const kit = instantiateWorld(world);
    assert.ok(kit.models[0] instanceof StaticModel);
    assert.ok(kit.models[1] instanceof FakeRbacModel);
    assert.ok(kit.models[2] instanceof FakeTupleModel);
    assert.equal(kit.models[1].name, 'rbac');
    assert.notEqual(kit.staticModel('m1', 'fs'), kit.staticModel('m1'));
    assert.equal(kit.nativeFilters.length, 1);
    assert.equal((await kit.tupleStore.read(ref('file', 'f1'), 'viewer')).length, 1);
    assert.equal(kit.clock.now().toISOString(), '2026-10-01T00:00:00.000Z');
    assert.equal(kit.row(ref('file', 'f1'))?.owner, 'alice');
    assert.equal(kit.relations[0].relation, 'editor');
    assert.deepEqual(await kit.context().ancestors(ref('org', 'o1')), [ref('org', 'o1'), GLOBAL]);
    assert.notEqual(instantiateWorld(world).models[0], kit.models[0]);
  });

  it('resolves principals by key or as given, and names a missing one', () => {
    const kit = instantiateWorld(world);
    assert.equal(kit.principal('alice'), alice);
    assert.equal(kit.principal(SYSTEM), SYSTEM);
    assert.throws(() => kit.principal('zed'), /no principal "zed"/);
    assert.throws(() => kit.staticModel('rbac'), /not a StaticModel/);
    assert.throws(() => kit.model('m1', 'nowhere'), /no domain "nowhere"/);
  });
});
