import * as chai from 'chai';
import 'mocha';
import { BUILTIN_CONDITION_FUNCTIONS, ConditionFunction, DefaultConditionCompiler, FALSE, TRUE } from '@spinajs/authz';
import type { Principal, ResourceFilter, Vote } from '@spinajs/authz';
import { evaluateFilter, fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';

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
    expect(no.cacheable).to.equal(false);
    const unknown = await vote(who, resource, {});
    expect(unknown).to.deep.include({ permitWhen: FALSE, reason: { code: 'caveat_unknown', model: 'rebac', caveats: [caveat] }, cacheable: false });
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

  it('the type-level residual of a caveat without parameters is decided per row, not dropped', async () => {
    const hours = { params: {}, expr: { fn: 'time.between', args: { from: '09:00', to: '17:00' } } };
    const m = new RebacModel({ store: new MemoryTupleStore([{ ...tuple(d1, 'viewer', user('bob')), caveat: { name: 'hours' } }]), namespaces: { user: {}, doc: { relations: { viewer: ['user with hours'] } } }, permissions: { 'doc:read': 'doc#viewer' }, caveats: { hours } });
    await m.init(fakeModelInitContext({ permissions: INPUTS, model: m.name }));
    const at = (iso: string) => fakeEvaluationContext({ conditions: new DefaultConditionCompiler(), permissions: INPUTS, nativeFilters: [m.nativeFilter], now: new Date(iso) });
    const v = await m.evaluate({ principal: userPrincipal('bob'), permission: 'doc:read', resource: { type: 'doc' }, env: {} }, at('2026-11-17T10:00:00Z'));
    const permit = v.permitWhen as Extract<ResourceFilter, { op: string; args: unknown }>;
    expect(permit.args).to.deep.equal({ relation: 'viewer', principal: { type: 'user', id: 'bob' }, caveatInput: {}, caveatRequest: { env: {}, principal: userPrincipal('bob') } });
    expect(v.cacheable).to.equal(false);
    expect(await m.nativeFilter.matches(permit.args, {}, d1, at('2026-11-17T10:00:00Z'))).to.equal(true);
    expect(await m.nativeFilter.matches(permit.args, {}, d1, at('2026-11-17T20:00:00Z'))).to.equal(false);
  });

  describe('caveats that call a condition function', () => {
    // Permissive when its input is missing: only the request env can make it deny.
    class NotBlocked extends ConditionFunction {
      readonly name = 'not_blocked';
      evaluate(_args: unknown, c: { principal: Principal; env: Readonly<Record<string, unknown>> }): boolean {
        return c.env.ip !== '6.6.6.6';
      }
    }
    let fns: RebacModel;
    const fnCtx = () => fakeEvaluationContext({ conditions: new DefaultConditionCompiler([...BUILTIN_CONDITION_FUNCTIONS, new NotBlocked()]), permissions: INPUTS, nativeFilters: [fns.nativeFilter] });

    before(async () => {
      const caveats = { open_net: { params: {}, expr: { fn: 'not_blocked' } }, office: { params: {}, expr: { fn: 'ip.in', args: { cidrs: ['10.0.0.0/8'] } } } };
      const tuples = [
        { ...tuple(d1, 'viewer', user('bob')), caveat: { name: 'open_net' } },
        { ...tuple(d2, 'viewer', user('bob')), caveat: { name: 'office' } },
      ];
      fns = new RebacModel({ store: new MemoryTupleStore(tuples), namespaces: { user: {}, doc: { relations: { viewer: ['user with open_net', 'user with office'] } } }, permissions: { 'doc:read': 'doc#viewer' }, caveats });
      await fns.init(fakeModelInitContext({ permissions: INPUTS, model: fns.name }));
    });

    it('the residual lists a row exactly when the check permits it, with the env and principal the check sees', async () => {
      for (const env of [{ ip: '6.6.6.6' }, { ip: '10.1.2.3' }, {}]) {
        const residual = await fns.evaluate({ principal: userPrincipal('bob'), permission: 'doc:read', resource: { type: 'doc' }, env }, fnCtx());
        expect(residual.cacheable).to.equal(false);
        for (const row of [d1, d2]) {
          const check = (await fns.evaluate({ principal: userPrincipal('bob'), permission: 'doc:read', resource: row, env }, fnCtx())).permitWhen === TRUE;
          const listed = await evaluateFilter(residual.permitWhen, {}, { principal: userPrincipal('bob'), ref: row, env, nativeFilters: [fns.nativeFilter], context: fnCtx() });
          expect(listed === true, `${row.id} ${JSON.stringify(env)}`).to.equal(check);
        }
      }
      const blocked = await fns.evaluate({ principal: userPrincipal('bob'), permission: 'doc:read', resource: { type: 'doc' }, env: { ip: '6.6.6.6' } }, fnCtx());
      expect(await fns.nativeFilter.matches((blocked.permitWhen as Extract<ResourceFilter, { args: unknown }>).args, {}, d1, fnCtx())).to.equal(false);
      const office = await fns.evaluate({ principal: userPrincipal('bob'), permission: 'doc:read', resource: { type: 'doc' }, env: { ip: '10.1.2.3' } }, fnCtx());
      expect(await fns.nativeFilter.matches((office.permitWhen as Extract<ResourceFilter, { args: unknown }>).args, {}, d2, fnCtx())).to.equal(true);
    });

    it('listSubjects without a principal leaves a function caveat undecided', async () => {
      expect(await fns.listSubjects(d1, 'viewer', 'user', { env: {}, ctx: fnCtx() })).to.deep.equal({ subjects: [], conditional: [user('bob')], complete: true });
    });
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
