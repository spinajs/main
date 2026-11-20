import * as chai from 'chai';
import 'mocha';
import { DefaultConditionCompiler, FALSE, TRUE } from '@spinajs/authz';
import type { ResourceFilter, Vote } from '@spinajs/authz';
import { fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';

import { MemoryTupleStore, RebacModel } from '../../src/index.js';
import { INPUTS, caveatModel } from '../support/caveat-world.js';
import { d1, d2, d3, ref, set, setup, tuple, user } from '../support/world.js';

const expect = chai.expect;

describe('authz-rebac: RebacModel with conditional tuples', () => {
  let model: RebacModel;
  const ctx = () => fakeEvaluationContext({ conditions: new DefaultConditionCompiler(), permissions: INPUTS, nativeFilters: [model.nativeFilter] });
  const vote = (who: string, resource: { type: string; id?: string }, env: Record<string, unknown>): Promise<Vote> => model.evaluate({ principal: userPrincipal(who), permission: 'doc:read', resource, env }, ctx());

  before(async () => {
    model = await caveatModel();
  });

  async function threeWays(who: string, resource: typeof d1, allow: Record<string, unknown>, deny: Record<string, unknown>, caveat: string): Promise<void> {
    const yes = await vote(who, resource, allow);
    expect(yes.permitWhen, `${who} allow`).to.equal(TRUE);
    expect(yes.cacheable).to.equal(false);
    const no = await vote(who, resource, deny);
    expect(no.permitWhen, `${who} deny`).to.equal(FALSE);
    expect(no.reason?.code).to.equal('no_access');
    const unknown = await vote(who, resource, {});
    expect(unknown).to.deep.include({ permitWhen: FALSE, reason: { code: 'caveat_unknown', model: 'rebac', caveats: [caveat] } });
    expect(unknown.error).to.equal(undefined);
  }

  it('a direct conditional tuple holds when its caveat does', () => threeWays('bob', d1, { ip: '10.0.0.1' }, { ip: '10.0.0.2' }, 'office_ip'));

  it('a conditional subject set holds when its caveat does', () => threeWays('carl', d1, { ip: '10.0.0.1' }, { ip: '10.0.0.2' }, 'office_ip'));

  it('a conditional arrow holds when its caveat does, with the tuple context', () => threeWays('dora', d2, { day: 10 }, { day: 25 }, 'not_expired'));

  it('a check that reaches no caveat is cacheable, as before', async () => {
    expect(await vote('erin', d3, { ip: '10.0.0.1' })).to.deep.include({ permitWhen: TRUE, cacheable: true });
  });

  it('the type-level residual carries the request values of the reachable caveat parameters', async () => {
    const v = await vote('bob', { type: 'doc' }, { ip: '10.0.0.1', ua: 'x' });
    const permit = v.permitWhen as Extract<ResourceFilter, { op: string; args: unknown }>;
    expect(permit.args).to.deep.equal({ relation: 'read', principal: { type: 'user', id: 'bob' }, caveatInput: { 'env.ip': '10.0.0.1' } });
    expect(v.cacheable).to.equal(false);
    expect(await model.nativeFilter.matches(permit.args, {}, d1, ctx())).to.equal(true);
    expect(await model.nativeFilter.matches({ ...(permit.args as object), caveatInput: { 'env.ip': '10.0.0.2' } }, {}, d1, ctx())).to.equal(false);
  });

  describe('a caveat over the principal identity', () => {
    const who = { params: { 'principal.id': 'string' }, expr: { attr: 'principal.id', eq: 'bob' } } as const;
    let only: RebacModel;

    before(async () => {
      const tuples = [tuple(ref('group', 'eng'), 'member', user('bob')), tuple(ref('group', 'eng'), 'member', user('carl')), { ...tuple(d1, 'viewer', set('group', 'eng', 'member')), caveat: { name: 'who', context: { 'principal.id': 'bob' } } }];
      only = new RebacModel({ store: new MemoryTupleStore(tuples), namespaces: { user: {}, group: { relations: { member: ['user'] } }, doc: { relations: { viewer: ['group#member with who'] } } }, permissions: { 'doc:read': 'doc#viewer' }, caveats: { who } });
      await only.init(fakeModelInitContext({ permissions: INPUTS, model: only.name }));
    });

    it('a tuple context cannot replace who is asking', async () => {
      const permits = async (id: string) => (await only.evaluate({ principal: userPrincipal(id), permission: 'doc:read', resource: d1, env: {} }, ctx())).permitWhen;
      expect(await permits('bob')).to.equal(TRUE);
      expect(await permits('carl')).to.equal(FALSE);
    });

    it('listSubjects without a principal leaves an identity caveat undecided', async () => {
      expect(await only.listSubjects(d1, 'viewer', 'user', { env: {} })).to.deep.equal({ subjects: [], conditional: [user('bob'), user('carl')], complete: true });
    });
  });

  it('maxDepth on a path without caveats is still an error vote', async () => {
    const shallow = await setup({ limit: { maxDepth: 1 } });
    const v = await shallow.model.evaluate({ principal: userPrincipal('olga'), permission: 'doc:read', resource: d1, env: {} }, ctx());
    expect(v.error).to.be.a('string').that.includes('maxDepth 1');
  });
});
