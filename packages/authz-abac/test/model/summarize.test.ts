import * as chai from 'chai';
import 'mocha';
import { Authorizer, DefaultConditionCompiler, GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import type { Policy, Principal } from '@spinajs/authz';
import { FakeScopeResolver, fakeEvaluationContext, fakeModelInitContext, servicePrincipal, userPrincipal } from '@spinajs/authz-testing';

import { AbacModel, ConfigPolicyStore } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const O1 = { type: 'org', id: 'o1' };
const F1 = { type: 'file', id: 'f1' };

const registry = (readTypes: readonly string[] = ['doc', 'file']): PermissionRegistryImpl => {
  const r = new PermissionRegistryImpl();
  r.register(
    [
      { name: 'doc:read', types: readTypes, fields: true },
      { name: 'doc:write', types: ['doc', 'file'] },
      { name: 'doc:delete', types: ['doc', 'file'] },
    ],
    'test',
  );
  r.freeze();
  return r;
};

const policy = (id: string, extra: Partial<Policy> = {}): Policy => ({ id, effect: 'permit', permissions: ['doc:read'], source: 'test', ...extra });

async function model(policies: readonly Policy[], reg = registry()): Promise<AbacModel> {
  const m = new AbacModel({ stores: [new ConfigPolicyStore(policies)] });
  await m.init(fakeModelInitContext({ permissions: reg }));
  return m;
}

const resolver = () => new FakeScopeResolver({ nodes: [{ ref: F1, parent: O1 }] });
const ctx = (reg = registry()) => fakeEvaluationContext({ now: NOW, permissions: reg, scopeResolvers: [resolver()], conditions: new DefaultConditionCompiler() });

const alice = userPrincipal('alice', { attributes: { team: 'x', level: 'high' } });
const bob = userPrincipal('bob', { attributes: { team: 'y' } });
const svc = servicePrincipal('svc');

describe('authz-abac: summarize (H18)', () => {
  it("lists the permit policies' permissions for the principal at GLOBAL, conditions bound for it", async () => {
    const m = await model([policy('read'), policy('team-x', { permissions: ['doc:write'], when: { attr: 'principal.attributes.team', eq: 'x' } }), policy('own', { permissions: ['doc:delete'], when: { attr: 'resource.owner', eq: { ref: 'principal.id' } } }), policy('deny', { effect: 'deny', permissions: ['doc:*'] }), policy('services', { permissions: ['doc:write'], principalTypes: ['service'] })]);
    expect(await m.summarize(alice, GLOBAL, ctx())).to.deep.equal({
      model: 'abac',
      permissions: [
        { name: 'doc:delete', conditional: true },
        { name: 'doc:read', conditional: false, fields: { read: ['*'], write: ['*'] } },
        { name: 'doc:write', conditional: false },
      ],
    });
    expect((await m.summarize(bob, GLOBAL, ctx())).permissions.map((p) => p.name)).to.deep.equal(['doc:delete', 'doc:read']);
    expect((await m.summarize(svc, GLOBAL, ctx())).permissions.map((p) => p.name)).to.deep.equal(['doc:delete', 'doc:read', 'doc:write']);
  });

  it('an unconditional policy wins over a conditional one for the same permission; fields go with it', async () => {
    const m = await model([policy('cond', { when: { attr: 'resource.status', eq: 'open' } }), policy('all', { fields: { read: ['name'] } })]);
    expect((await m.summarize(alice, GLOBAL, ctx())).permissions).to.deep.equal([{ name: 'doc:read', conditional: false, fields: { read: ['name'], write: [] } }]);
  });

  it('decides scopes on the path of `at`; a scoped policy is listed conditional at GLOBAL (it holds below its node)', async () => {
    const m = await model([policy('o1', { scope: O1 })]);
    expect((await m.summarize(alice, GLOBAL, ctx())).permissions).to.deep.equal([{ name: 'doc:read', conditional: true, fields: { read: ['*'], write: ['*'] } }]);
    expect((await m.summarize(alice, F1, ctx())).permissions).to.deep.equal([{ name: 'doc:read', conditional: false, fields: { read: ['*'], write: ['*'] } }]);
  });

  it('judges a permission per type of it at GLOBAL: a typed permit is listed, unconditional only when every type has one', async () => {
    const docs = policy('docs', { resourceTypes: ['doc'] });
    const docOnly = registry(['doc']);
    expect((await (await model([docs], docOnly)).summarize(alice, GLOBAL, ctx(docOnly))).permissions).to.deep.equal([{ name: 'doc:read', conditional: false, fields: { read: ['*'], write: ['*'] } }]);
    expect((await (await model([docs])).summarize(alice, GLOBAL, ctx())).permissions).to.deep.equal([{ name: 'doc:read', conditional: true, fields: { read: ['*'], write: ['*'] } }]);
    const both = await model([docs, policy('files', { resourceTypes: ['file'], fields: { read: ['name'] } })]);
    expect((await both.summarize(alice, GLOBAL, ctx())).permissions).to.deep.equal([{ name: 'doc:read', conditional: false, fields: { read: ['*'], write: ['*'] } }]);
  });

  it("at GLOBAL the fields are the union of each type's field set, never fewer than one type gives", async () => {
    const m = await model([policy('docs', { resourceTypes: ['doc'], scope: O1, fields: { read: ['a'] } }), policy('files', { resourceTypes: ['file'], scope: O1, fields: { read: ['b'], write: ['b'] } })]);
    expect((await m.summarize(alice, GLOBAL, ctx())).permissions).to.deep.equal([{ name: 'doc:read', conditional: true, fields: { read: ['a', 'b'], write: ['b'] } }]);
  });

  it('a condition reading scope.<type>.* is listed conditional at GLOBAL; one false for the principal is not listed', async () => {
    const m = await model([policy('open', { when: { attr: 'scope.org.open', eq: true } }), policy('team-x', { permissions: ['doc:write'], when: { attr: 'principal.attributes.team', eq: 'x' } })]);
    expect((await m.summarize(alice, GLOBAL, ctx())).permissions).to.deep.equal([
      { name: 'doc:read', conditional: true, fields: { read: ['*'], write: ['*'] } },
      { name: 'doc:write', conditional: false },
    ]);
    expect((await m.summarize(bob, GLOBAL, ctx())).permissions.map((p) => p.name)).to.deep.equal(['doc:read']);
  });

  describe('a permit false now but resting on session facts is listed conditional (review R2-I1, C4)', () => {
    const del = userPrincipal('del', { attributes: { dept: 'eng' } });
    const listed = [{ name: 'doc:delete', conditional: true }];
    const deletes = (extra: Partial<Policy>) => policy('deletes', { permissions: ['doc:delete'], ...extra });
    const cases: readonly [string, Partial<Policy>, Principal?][] = [
      [
        'env.now (P6: from 13:00, now 12:00)',
        {
          when: {
            all: [
              { attr: 'principal.id', eq: 'del' },
              { attr: 'env.now', gte: '2026-10-01T13:00:00.000Z' },
            ],
          },
        },
      ],
      ['principal.authn (step-up), target without authn facts', { when: { attr: 'principal.authn.assurance', eq: 'aal2' } }],
      ['principal.authn (step-up), target at aal1', { when: { attr: 'principal.authn.assurance', eq: 'aal2' } }, userPrincipal('del', { authn: { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: NOW } })],
      ['actor.attributes', { when: { attr: 'actor.attributes.dept', eq: 'sales' } }],
      ['a function with literal arguments', { when: { fn: 'glob', args: { value: 'abc', pattern: 'x*' } } }],
      ["actorTypes: ['agent'] for a user", { actorTypes: ['agent'] }],
    ];
    for (const [name, extra, target] of cases) {
      it(name, async () => {
        const m = await model([deletes(extra)]);
        expect((await m.summarize(target ?? del, GLOBAL, ctx())).permissions).to.deep.equal(listed);
        expect((await m.summarize(target ?? del, F1, ctx())).permissions).to.deep.equal(listed);
      });
    }

    it('a condition on principal attributes, id or type that is false for the principal is not listed (control)', async () => {
      const m = await model([
        deletes({ when: { attr: 'principal.attributes.dept', eq: 'sales' } }),
        deletes({
          id: 'ids',
          when: {
            all: [
              { attr: 'principal.id', eq: 'other' },
              { attr: 'principal.type', eq: 'user' },
            ],
          },
        }),
      ]);
      expect((await m.summarize(del, GLOBAL, ctx())).permissions).to.deep.equal([]);
      expect((await m.summarize(del, F1, ctx())).permissions).to.deep.equal([]);
    });

    it('expiry and principalTypes still drop such a permit', async () => {
      const m = await model([deletes({ when: { attr: 'env.now', gte: '2026-10-01T13:00:00.000Z' }, expiresAt: new Date(NOW.getTime() - 1) }), deletes({ id: 'svc', actorTypes: ['agent'], principalTypes: ['service'] })]);
      expect((await m.summarize(del, GLOBAL, ctx())).permissions).to.deep.equal([]);
    });
  });

  it('drops expired policies and those a principal condition rules out', async () => {
    const m = await model([policy('old', { expiresAt: new Date(NOW.getTime() - 1) }), policy('low', { permissions: ['doc:write'], when: { attr: 'principal.attributes.level', eq: 'low' } })]);
    expect((await m.summarize(alice, GLOBAL, ctx())).permissions).to.deep.equal([]);
  });

  describe('through the engine (B26: covers counts ABAC policies)', () => {
    const engine = async (policies: readonly Policy[]) => {
      const reg = registry();
      return new Authorizer({ domain: 'root', models: [await model(policies, reg)], registry: reg, scopeResolvers: [resolver()], conditions: new DefaultConditionCompiler(), clock: () => NOW });
    };
    const covers = (a: Authorizer, holder: Principal, target: Principal) => a.covers(holder, target);

    it('summary lists what the policies give after the checks', async () => {
      const a = await engine([policy('read'), policy('team-x', { permissions: ['doc:write'], when: { attr: 'principal.attributes.team', eq: 'x' } }), policy('no-write-y', { effect: 'deny', permissions: ['doc:write'], when: { attr: 'principal.attributes.team', eq: 'y' } })]);
      const s = await a.summary(alice);
      expect(s.permissions.map((p) => [p.name, p.conditional])).to.deep.equal([
        ['doc:read', false],
        ['doc:write', false],
      ]);
      expect(s.models.map((m) => m.model)).to.deep.equal(['abac']);
      expect((await a.summary(bob)).permissions.map((p) => p.name)).to.deep.equal(['doc:read']);
    });

    it('a deny policy on the holder takes a permission out of its set, one on the target does not (RFC E1-1); a permit adds to the target', async () => {
      const deny = await engine([policy('all', { permissions: ['doc:*'] }), policy('y-no-delete', { effect: 'deny', permissions: ['doc:delete'], when: { attr: 'principal.attributes.team', eq: 'y' } })]);
      expect(await covers(deny, bob, alice)).to.equal(false);
      // bob's summary lists doc:delete from 'all', and a target's deny never clears a summary entry.
      expect(await covers(deny, alice, bob)).to.equal(false);
      const xDeletes = await engine([policy('all', { permissions: ['doc:read', 'doc:write'] }), policy('x-deletes', { permissions: ['doc:delete'], when: { attr: 'principal.attributes.team', eq: 'x' } })]);
      expect(await covers(xDeletes, alice, bob)).to.equal(true);
      const permit = await engine([policy('read'), policy('team-x', { permissions: ['doc:write'], when: { attr: 'principal.attributes.team', eq: 'x' } })]);
      expect(await covers(permit, bob, alice)).to.equal(false);
      expect(await covers(permit, alice, bob)).to.equal(true);
    });

    describe('a target whose permission comes only from a typed or scoped permit (RFC L1-3)', () => {
      const t = userPrincipal('t');
      const caller = userPrincipal('c');
      const holder = userPrincipal('h');
      const others = [policy('c-writes', { permissions: ['doc:write'], when: { attr: 'principal.id', eq: 'c' } }), policy('h-all', { permissions: ['doc:read', 'doc:write'], when: { attr: 'principal.id', eq: 'h' } })];
      const only = { when: { attr: 'principal.id', eq: 't' } };
      const targets: readonly [string, Policy][] = [
        ['typed', policy('t-docs', { resourceTypes: ['doc'], ...only })],
        ['scoped', policy('t-o1', { scope: O1, ...only })],
      ];
      for (const [name, target] of targets) {
        it(`${name}: a caller without doc:read does not cover it, one with doc:read at GLOBAL and more does`, async () => {
          const a = await engine([...others, target]);
          expect(await covers(a, caller, t)).to.equal(false);
          expect(await covers(a, holder, t)).to.equal(true);
        });
      }
    });

    describe('a target permit false now but resting on session facts keeps covers false (review R2-I1, C4)', () => {
      const del = userPrincipal('del', { attributes: { dept: 'eng' } });
      const helper = userPrincipal('helper');
      const base = [policy('read'), policy('helper-writes', { permissions: ['doc:write'], when: { attr: 'principal.id', eq: 'helper' } })];
      const deletes = (extra: Partial<Policy>) => policy('deletes', { permissions: ['doc:delete'], ...extra });
      const cases: readonly [string, Partial<Policy>][] = [
        [
          'env.now (P6)',
          {
            when: {
              all: [
                { attr: 'principal.id', eq: 'del' },
                { attr: 'env.now', gte: '2026-10-01T13:00:00.000Z' },
              ],
            },
          },
        ],
        ['principal.authn (step-up)', { when: { attr: 'principal.authn.assurance', eq: 'aal2' } }],
        ['actor.attributes', { when: { attr: 'actor.attributes.dept', eq: 'sales' } }],
        ['a function', { when: { fn: 'glob', args: { value: 'abc', pattern: 'x*' } } }],
        ["actorTypes: ['agent']", { actorTypes: ['agent'] }],
      ];
      it('controls: without the permit, or with one on a principal attribute false for the target, helper covers del', async () => {
        expect(await covers(await engine(base), helper, del)).to.equal(true);
        expect(await covers(await engine([...base, deletes({ when: { attr: 'principal.attributes.dept', eq: 'sales' } })]), helper, del)).to.equal(true);
      });
      for (const [name, extra] of cases) {
        it(name, async () => {
          expect(await covers(await engine([...base, deletes(extra)]), helper, del)).to.equal(false);
        });
      }
    });
  });
});
