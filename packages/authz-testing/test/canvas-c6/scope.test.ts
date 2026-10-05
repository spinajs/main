import { GLOBAL } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import AjvModule from 'ajv';
import type { Options, ValidateFunction } from 'ajv';
import * as chai from 'chai';

import type { Resource } from './c6/authz.js';
import { evaluate } from './c6/reference.js';
import { DEFAULT_ORG_POLICIES } from './c6/state.js';
import { loadCanvasFixtures } from './fixtures.js';
import { branchRef, canvasScopeContributor, CanvasScopeResolver, ORG_ATTRIBUTE_SCHEMA, parseBranchId } from './scope.js';

const expect = chai.expect;

// Same construction as the core's schemaValidator (admin/scope-attributes/schemas.ts): ajv 8, strict schema.
const Ajv = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as unknown as new (opts: Options) => { compile(schema: object): ValidateFunction };

const UNKNOWN = '00000000-0000-4000-8000-000000000000';

describe('canvas C6 scope resolver', () => {
  const f = loadCanvasFixtures();
  const id = (symbol: string): string => {
    const uuid = f.ids.get(symbol);
    if (uuid === undefined) throw new Error(`no fixture id ${symbol}`);
    return uuid;
  };
  const resolver = new CanvasScopeResolver(f.state);
  const org = (s: string): ResourceRef => ({ type: 'org', id: id(s) });
  const project = (s: string): ResourceRef => ({ type: 'project', id: id(s) });
  const file = (s: string): ResourceRef => ({ type: 'file', id: id(s) });
  const branch = (p: string, fl: string | null, name: string): ResourceRef => branchRef(id(p), fl === null ? null : id(fl), name);

  const refOf = (r: Resource): ResourceRef => {
    switch (r.kind) {
      case 'org':
        return { type: 'org', id: r.org };
      case 'project':
        return { type: 'project', id: r.project };
      case 'file':
        return { type: 'file', id: r.file };
      case 'branch':
        return branchRef(r.project, r.file, r.branch);
    }
  };

  it('handles the canvas types', () => {
    expect(resolver.types).to.deep.equal(['org', 'project', 'file', 'branch', 'group']);
  });

  describe('ancestors', () => {
    it('org: [org, GLOBAL]', async () => {
      for (const s of ['ACME', 'STRICT', 'OPEN', 'SEALED']) expect(await resolver.ancestors(org(s))).to.deep.equal([org(s), GLOBAL]);
    });

    it('project: [project, org, GLOBAL]', async () => {
      const cases: [string, string][] = [
        ['WEB', 'ACME'],
        ['PRIVATE', 'ACME'],
        ['LOCKED', 'STRICT'],
        ['OPENPROJ', 'OPEN'],
        ['VAULT', 'SEALED'],
      ];
      for (const [p, o] of cases) expect(await resolver.ancestors(project(p))).to.deep.equal([project(p), org(o), GLOBAL]);
    });

    it('file: [file, project, org, GLOBAL]', async () => {
      const cases: [string, string, string][] = [
        ['HOME', 'WEB', 'ACME'],
        ['SECRET', 'WEB', 'ACME'],
        ['SHARED', 'PRIVATE', 'ACME'],
        ['BRIEF', 'LOCKED', 'STRICT'],
      ];
      for (const [fl, p, o] of cases) expect(await resolver.ancestors(file(fl))).to.deep.equal([file(fl), project(p), org(o), GLOBAL]);
    });

    it('branch with a file: [branch, file, project, org, GLOBAL]', async () => {
      const b = branch('WEB', 'HOME', 'main');
      expect(await resolver.ancestors(b)).to.deep.equal([b, file('HOME'), project('WEB'), org('ACME'), GLOBAL]);
    });

    it('branch without a file: [branch, project, org, GLOBAL]', async () => {
      const b = branch('WEB', null, 'release/1.0');
      expect(await resolver.ancestors(b)).to.deep.equal([b, project('WEB'), org('ACME'), GLOBAL]);
    });

    it('returns frozen lists of frozen refs', async () => {
      const list = (await resolver.ancestors(branch('WEB', 'HOME', 'main')))!;
      expect(Object.isFrozen(list)).to.equal(true);
      expect(list.every((r) => Object.isFrozen(r))).to.equal(true);
    });

    it('group: [group, org, GLOBAL]', async () => {
      const design: ResourceRef = { type: 'group', id: id('DESIGN') };
      expect(await resolver.ancestors(design)).to.deep.equal([design, org('ACME'), GLOBAL]);
      expect(await resolver.attributes(design)).to.deep.equal({});
    });

    it('a type-level ref of a canvas type gives [ref, GLOBAL], as the engine does', async () => {
      for (const type of ['org', 'project', 'file', 'branch', 'group']) expect(await resolver.ancestors({ type })).to.deep.equal([{ type }, GLOBAL]);
    });

    describe('null (unknown resource)', () => {
      const unknown: [string, () => ResourceRef][] = [
        ['GHOST, a file id with no file row', () => file('GHOST')],
        ['an unknown org', () => ({ type: 'org', id: UNKNOWN })],
        ['an unknown project', () => ({ type: 'project', id: UNKNOWN })],
        ['an unknown file', () => ({ type: 'file', id: UNKNOWN })],
        ['a project id used as an org', () => ({ type: 'org', id: id('WEB') })],
        ['a branch of WEB whose file SHARED is in PRIVATE', () => branch('WEB', 'SHARED', 'main')],
        ['a branch with an unknown file', () => branch('WEB', 'GHOST', 'main')],
        ['a branch of an unknown project', () => branchRef(UNKNOWN, null, 'main')],
        ['a branch id with two parts', () => ({ type: 'branch', id: `${id('WEB')}:main` })],
        ['a branch id with four parts', () => ({ type: 'branch', id: `${id('WEB')}::main:x` })],
        ['a branch id with a bad escape', () => ({ type: 'branch', id: `${id('WEB')}::%E0%A4%A` })],
        ['a branch id with an empty name', () => ({ type: 'branch', id: `${id('WEB')}::` })],
        ['a branch id not in canonical encoding', () => ({ type: 'branch', id: `${id('WEB')}::release%2f1.0` })],
        ['an unknown group', () => ({ type: 'group', id: UNKNOWN })],
        ['an org id used as a group', () => ({ type: 'group', id: id('ACME') })],
        ['a type the resolver does not handle', () => ({ type: 'user', id: id('ED') })],
      ];
      for (const [name, ref] of unknown) {
        it(name, async () => {
          expect(await resolver.ancestors(ref())).to.equal(null);
          expect(await resolver.attributes(ref())).to.equal(null);
        });
      }
    });

    it('agrees with C6 resolve() on every case resource and the unknown ones', async () => {
      const anyUser = { kind: 'user' as const, user: id('ED') };
      const resources: Resource[] = [
        ...f.cases.map((c) => c.resource),
        { kind: 'org', org: UNKNOWN },
        { kind: 'project', project: UNKNOWN },
        { kind: 'file', file: UNKNOWN },
        { kind: 'branch', project: id('WEB'), file: null, branch: 'main' },
        { kind: 'branch', project: id('WEB'), file: id('SHARED'), branch: 'main' },
        { kind: 'branch', project: id('WEB'), file: id('GHOST'), branch: 'main' },
        { kind: 'branch', project: UNKNOWN, file: null, branch: 'main' },
      ];
      expect(f.cases).to.have.length(64);
      let unknownSeen = 0;
      for (const r of resources) {
        const d = evaluate(f.state, anyUser, 'project.read', r);
        const oracleUnknown = !d.allowed && d.reason.code === 'unknown_resource';
        if (oracleUnknown) unknownSeen++;
        expect((await resolver.ancestors(refOf(r))) === null, JSON.stringify(r)).to.equal(oracleUnknown);
      }
      expect(unknownSeen).to.be.greaterThan(4);
    });
  });

  describe('branch ids', () => {
    const names = ['main', 'release/1.0', 'hotfix/2-lts', 'a:b', '100%', '%41', 'feat/*', 'x::y', 'zażółć/gęślą', '日本/ブランチ', 'emoji-😀', ' spaced name '];

    for (const name of names) {
      it(`round-trips ${JSON.stringify(name)}`, () => {
        for (const fl of [id('HOME'), null]) {
          const ref = branchRef(id('WEB'), fl, name);
          expect(ref.type).to.equal('branch');
          expect(ref.id!.split(':')).to.have.length(3);
          expect(parseBranchId(ref.id!)).to.deep.equal({ project: id('WEB'), file: fl, name });
        }
      });
    }

    it('encodes an absent file as an empty part', () => {
      expect(branchRef('p', null, 'main').id).to.equal('p::main');
      expect(branchRef('p', 'f', 'a/b:c').id).to.equal('p:f:a%2Fb%3Ac');
    });

    it('refuses empty parts', () => {
      expect(() => branchRef('', null, 'main')).to.throw();
      expect(() => branchRef('p', '', 'main')).to.throw();
      expect(() => branchRef('p', null, '')).to.throw();
    });
  });

  describe('attributes', () => {
    it('a branch gives its name', async () => {
      expect(await resolver.attributes(branch('WEB', 'HOME', 'hotfix/2-lts'))).to.deep.equal({ name: 'hotfix/2-lts' });
      expect(await resolver.attributes(branch('WEB', null, 'feat/*'))).to.deep.equal({ name: 'feat/*' });
    });

    it('org, project and file give {} (org policies come from the attribute store)', async () => {
      for (const ref of [org('ACME'), org('STRICT'), project('WEB'), file('HOME')]) expect(await resolver.attributes(ref)).to.deep.equal({});
    });

    it('a type-level ref has no attributes', async () => {
      expect(await resolver.attributes({ type: 'org' })).to.equal(null);
    });
  });
});

describe('canvas C6 org attribute schema', () => {
  const f = loadCanvasFixtures();
  const validate = new Ajv({ logger: false, allErrors: false, addUsedSchema: false, validateSchema: true }).compile(ORG_ATTRIBUTE_SCHEMA.schema);
  const policiesSchema = (ORG_ATTRIBUTE_SCHEMA.schema as { properties: { policies: { properties: Record<string, unknown> } } }).properties.policies;

  it('is the org schema, contributed by canvasScopeContributor()', async () => {
    expect(ORG_ATTRIBUTE_SCHEMA.scopeType).to.equal('org');
    expect(await canvasScopeContributor().contribute()).to.deep.equal({ scopeAttributeSchemas: [ORG_ATTRIBUTE_SCHEMA] });
  });

  it('defaults equal C6 DEFAULT_ORG_POLICIES, as a plain unfrozen copy', () => {
    const policies = ORG_ATTRIBUTE_SCHEMA.defaults.policies as object;
    expect(ORG_ATTRIBUTE_SCHEMA.defaults).to.deep.equal({ policies: { ...DEFAULT_ORG_POLICIES } });
    expect(policies).to.not.equal(DEFAULT_ORG_POLICIES);
    expect(Object.isFrozen(policies)).to.equal(false);
  });

  it('names exactly the ten OrgPolicies keys', () => {
    expect(Object.keys(policiesSchema.properties).sort()).to.deep.equal(Object.keys(DEFAULT_ORG_POLICIES).sort());
    expect(Object.keys(policiesSchema.properties)).to.have.length(10);
  });

  it('the defaults pass', () => {
    expect(validate(ORG_ATTRIBUTE_SCHEMA.defaults), JSON.stringify(validate.errors)).to.equal(true);
  });

  it('every explicit policy object of state.json passes, alone and over the defaults', () => {
    expect(f.explicitPolicies.size).to.equal(4);
    for (const [org, given] of f.explicitPolicies) {
      expect(validate({ policies: given }), `${f.symbolOf(org)}: ${JSON.stringify(validate.errors)}`).to.equal(true);
      expect(validate({ policies: { ...DEFAULT_ORG_POLICIES, ...given } }), f.symbolOf(org)).to.equal(true);
    }
  });

  const badPolicies: [string, Record<string, unknown>][] = [
    ['a non-boolean flag', { public_links: 'sometimes' }],
    ['an unknown policy key', { secret_mode: true }],
    ['max_link_role none', { max_link_role: 'none' }],
    ['an unknown role', { guest_max_role: 'owner' }],
  ];
  for (const [name, policies] of badPolicies) {
    it(`refuses ${name}, alone and over the defaults`, () => {
      expect(validate({ policies })).to.equal(false);
      expect(validate({ policies: { ...DEFAULT_ORG_POLICIES, ...policies } })).to.equal(false);
    });
  }

  it('refuses an unknown top-level key and a non-object policies', () => {
    expect(validate({ policies: {}, extra: 1 })).to.equal(false);
    expect(validate({ policies: true })).to.equal(false);
  });
});
