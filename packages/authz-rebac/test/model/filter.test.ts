import * as chai from 'chai';
import 'mocha';
import { DefaultConditionCompiler } from '@spinajs/authz';
import type { PermissionDef, Principal } from '@spinajs/authz';
import { FakePermissionRegistry, fakeEvaluationContext, servicePrincipal, userPrincipal } from '@spinajs/authz-testing';

import { REBAC_TUPLES_PLAN_OP, caveatKey, parseRebacPlanArgs, rebacListPlan, subjectKey } from '../../src/index.js';
import type { RebacModel } from '../../src/index.js';
import { INPUTS, caveatModel } from '../support/caveat-world.js';
import { PERMISSION_INPUTS, setup, user } from '../support/world.js';
import type { Setup } from '../support/world.js';

const expect = chai.expect;

const def = (name: string): PermissionDef => new FakePermissionRegistry(PERMISSION_INPUTS).get(name)!;
const plan = (s: Setup, who: Principal, permission: string, type: string) => s.model.listPlan({ principal: who, permission: def(permission), type }, s.context());
const leaf = (relation: string, subjects: string[]) => ({ tuples: { relation, subjects } });
const terms = (args: unknown) => ({ kind: 'terms', permit: [{ op: REBAC_TUPLES_PLAN_OP, args }], deny: [] });

describe('authz-rebac: list plans', () => {
  let s: Setup;

  beforeEach(async () => {
    s = await setup();
  });

  it('every rewrite but exclusion can be planned', () => {
    expect(s.model.listSupport(def('doc:read'), 'doc')).to.equal(true);
    expect(s.model.listSupport(def('doc:edit'), 'doc')).to.equal(true);
    expect(s.model.listSupport(def('folder:read'), 'folder')).to.equal(true);
    const view = s.model.listSupport(def('doc:view'), 'doc');
    expect(view).to.be.an('object');
    expect((view as { reason: string }).reason).to.include('exclusion');
  });

  it('a union lists the relations the principal reaches, nested subject sets resolved from its side', async () => {
    expect(await plan(s, userPrincipal('olga'), 'doc:read', 'doc')).to.deep.equal(terms({ any: [leaf('owner', ['user:olga']), leaf('viewer', ['group:eng#member', 'group:ops#member', 'user:olga'])] }));
  });

  it('a tuple-to-userset names the objects the principal reaches through the tupleset', async () => {
    expect(await plan(s, userPrincipal('carol'), 'doc:read', 'doc')).to.deep.equal(terms({ any: [leaf('owner', ['user:carol']), leaf('viewer', ['user:carol']), leaf('parent', ['folder:f0', 'folder:f1'])] }));
    expect(await plan(s, userPrincipal('carol'), 'folder:read', 'folder')).to.deep.equal(terms({ any: [leaf('viewer', ['user:carol']), leaf('parent', ['folder:f0', 'folder:f1'])] }));
  });

  it('an intersection becomes all', async () => {
    expect(await plan(s, userPrincipal('bob'), 'doc:edit', 'doc')).to.deep.equal(terms({ all: [leaf('editor', ['user:bob']), leaf('approved', ['user:bob'])] }));
  });

  it('a principal no relation admits gets abstain', async () => {
    expect(await plan(s, servicePrincipal('svc'), 'doc:read', 'doc')).to.deep.equal({ kind: 'abstain' });
  });

  it('subject sets past limit.maxDepth stay out, as the check refuses them', async () => {
    const shallow = await setup({ limit: { maxDepth: 1 } });
    expect(await plan(shallow, userPrincipal('olga'), 'doc:read', 'doc')).to.deep.equal(terms({ any: [leaf('owner', ['user:olga']), leaf('viewer', ['group:ops#member', 'user:olga'])] }));
  });

  it('an exclusion cannot be planned', async () => {
    let error: unknown;
    await plan(s, userPrincipal('alice'), 'doc:view', 'doc').catch((e: unknown) => (error = e));
    expect((error as Error).message).to.include('exclusion');
  });

  it('agrees with the checks of every row it names', async () => {
    for (const who of ['alice', 'bob', 'carol', 'frank', 'olga']) {
      const p = await rebacListPlan({ schema: s.model.schema(), store: s.store, principal: user(who), permission: 'doc:read', type: 'doc', maxDepth: 8 });
      for (const id of ['d1', 'd2', 'd3']) {
        const listed = p.kind === 'terms' && (await matches((p.permit[0].args as never), id, s));
        expect(listed, `${who} on doc:${id}`).to.equal((await s.model.check({ type: 'doc', id }, 'read', user(who))) === 'member');
      }
    }
  });

  it('plan args parse back, and anything else is refused', () => {
    const args = { any: [leaf('owner', ['user:a']), { all: [leaf('viewer', ['user:a'])] }] };
    expect(parseRebacPlanArgs(JSON.parse(JSON.stringify(args)))).to.deep.equal(args);
    expect(() => parseRebacPlanArgs({ tuples: { relation: 'owner' } })).to.throw('rebac.tuples');
    expect(() => parseRebacPlanArgs({ any: 'x' })).to.throw('rebac.tuples');
    expect(() => parseRebacPlanArgs({ tuples: { relation: 'owner', subjects: ['user:a'] }, extra: 1 })).to.throw('rebac.tuples');
    expect(() => parseRebacPlanArgs(null)).to.throw('rebac.tuples');
  });

  it('plan args parse conditional groups, and refuse malformed ones', () => {
    const K = caveatKey({ name: 'office_ip' });
    const args = { tuples: { relation: 'viewer', subjects: [], conditional: [{ caveat: K, subjects: ['user:a'] }] } };
    expect(parseRebacPlanArgs(JSON.parse(JSON.stringify(args)))).to.deep.equal(args);
    for (const conditional of [[], [{ caveat: 'x', subjects: ['user:a'] }], [{ caveat: K, subjects: [] }], [{ caveat: K, subjects: ['user:a'], extra: 1 }]]) {
      expect(() => parseRebacPlanArgs({ tuples: { relation: 'viewer', subjects: [], conditional } }), JSON.stringify(conditional)).to.throw('rebac.tuples');
    }
    expect(() => parseRebacPlanArgs({ tuples: { relation: 'viewer', subjects: [], extra: 1 } })).to.throw('rebac.tuples');
  });
});

describe('authz-rebac: list plans with conditional tuples', () => {
  const NOW = new Date('2026-11-17T10:00:00.000Z');
  const OFFICE = caveatKey({ name: 'office_ip' });
  let model: RebacModel;
  const plan = (who: string, env: Record<string, unknown>) => model.listPlan({ principal: userPrincipal(who), permission: { name: 'doc:read' } as PermissionDef, type: 'doc', env }, fakeEvaluationContext({ permissions: INPUTS, conditions: new DefaultConditionCompiler(), now: NOW }));
  const conditional = (relation: string, subjects: string[], groups: { caveat: string; subjects: string[] }[]) => ({ tuples: { relation, subjects, conditional: groups } });

  before(async () => {
    model = await caveatModel();
  });

  it('keeps the conditional tuples of a caveat that holds for the request, valid until this instant', async () => {
    expect(await plan('bob', { ip: '10.0.0.1' })).to.deep.equal({ ...terms(conditional('viewer', ['user:bob'], [{ caveat: OFFICE, subjects: ['user:bob'] }])), validUntil: NOW });
    expect(await plan('carl', { ip: '10.0.0.1' })).to.deep.equal({ ...terms(conditional('viewer', ['user:carl'], [{ caveat: OFFICE, subjects: ['group:eng#member', 'user:carl'] }])), validUntil: NOW });
  });

  it('leaves out the conditional groups of a caveat that is false or unknown', async () => {
    expect(await plan('bob', { ip: '10.0.0.2' })).to.deep.equal({ ...terms(leaf('viewer', ['user:bob'])), validUntil: NOW });
    expect(await plan('carl', {})).to.deep.equal({ ...terms(leaf('viewer', ['user:carl'])), validUntil: NOW });
  });

  it('an arrow through a conditional tupleset lists its objects in a group of their own, the tuple context included', async () => {
    const expired = caveatKey({ name: 'not_expired', context: { 'env.until': 20 } });
    expect(await plan('dora', { day: 10 })).to.deep.equal({ ...terms({ any: [leaf('viewer', ['user:dora']), conditional('parent', [], [{ caveat: expired, subjects: ['folder:f1'] }])] }), validUntil: NOW });
    expect(await plan('dora', { day: 25 })).to.deep.equal({ ...terms(leaf('viewer', ['user:dora'])), validUntil: NOW });
  });

  it('a plan that evaluated no caveat stays reusable, and every rewrite but exclusion can still be planned', async () => {
    expect(await plan('erin', { ip: '10.0.0.1' })).to.deep.equal(terms(leaf('viewer', ['user:erin'])));
    expect(model.listSupport({ name: 'doc:read' } as PermissionDef, 'doc')).to.equal(true);
  });
});

/** The expression on one doc row, read from the store as the SQL term would. */
async function matches(expr: Record<string, unknown>, id: string, s: Setup): Promise<boolean> {
  if ('any' in expr) {
    for (const e of expr.any as Record<string, unknown>[]) if (await matches(e, id, s)) return true;
    return false;
  }
  if ('all' in expr) {
    for (const e of expr.all as Record<string, unknown>[]) if (!(await matches(e, id, s))) return false;
    return true;
  }
  const { relation, subjects } = expr.tuples as { relation: string; subjects: string[] };
  const found = await s.store.find({ object: { type: 'doc', id }, relation });
  return found.items.some((t) => subjects.includes(subjectKey(t.subject)));
}
