import * as chai from 'chai';
import 'mocha';
import { Authorizer, BUILTIN_CONDITION_FUNCTIONS, ConditionFunction, DefaultConditionCompiler, defaultAttribute, evaluateResidual } from '@spinajs/authz';
import type { CheckInput, Principal, ResourceFilter, ResourceRef } from '@spinajs/authz';
import { FakePermissionRegistry, fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';

import { MemoryTupleStore, RebacModel } from '../../src/index.js';
import type { CaveatConfig, Tuple } from '../../src/index.js';
import { tuple, user } from '../support/world.js';

const expect = chai.expect;

type FnContext = { principal: Principal; env: Readonly<Record<string, unknown>> };

// Permissive when its input is missing: only the request env can make it deny.
class NotBlocked extends ConditionFunction {
  readonly name = 'not_blocked';
  evaluate(_args: unknown, c: FnContext): boolean {
    return c.env.ip !== '6.6.6.6';
  }
}

/** Reads the app's user object, which a residual's vote could never carry. */
class Unlocked extends ConditionFunction {
  readonly name = 'unlocked';
  evaluate(_args: unknown, c: FnContext): boolean {
    const identity: unknown = c.principal.identity;
    return !(typeof identity === 'object' && identity !== null && Reflect.get(identity, 'locked') === true);
  }
}

class UserRecord {
  constructor(readonly locked: boolean) {}
}

const NOW = new Date('2026-11-17T10:00:00.000Z');
const doc = (id: string): ResourceRef => ({ type: 'doc', id });
const INPUTS = [{ name: 'doc:read', types: ['doc'] }];
const conditions = new DefaultConditionCompiler([...BUILTIN_CONDITION_FUNCTIONS, new NotBlocked(), new Unlocked()]);

async function rebac(caveats: CaveatConfig, tuples: readonly Tuple[]): Promise<RebacModel> {
  const model = new RebacModel({ store: new MemoryTupleStore(tuples), namespaces: { user: {}, doc: { relations: { viewer: Object.keys(caveats).map((c) => `user with ${c}`) } } }, permissions: { 'doc:read': 'doc#viewer' }, caveats });
  await model.init(fakeModelInitContext({ permissions: INPUTS, model: model.name }));
  return model;
}

/** The residual evaluated on one row as the engine evaluates a filter. */
const listed = (model: RebacModel, residual: ResourceFilter, who: Principal, row: ResourceRef): Promise<boolean | undefined> =>
  evaluateResidual(residual, {}, { principal: who, ref: row, attribute: defaultAttribute, relation: () => undefined, ancestors: () => Promise.resolve(null), native: () => model.nativeFilter, ctx: fakeEvaluationContext({ conditions, permissions: INPUTS, now: NOW }) });

describe('authz-rebac: caveats that call condition functions, through the engine', () => {
  const caveats: CaveatConfig = {
    open_net: { params: {}, expr: { fn: 'not_blocked' } },
    office: { params: {}, expr: { fn: 'ip.in', args: { cidrs: ['10.0.0.0/8'] } } },
    unlocked: { params: {}, expr: { fn: 'unlocked' } },
    hours: { params: {}, expr: { fn: 'time.between', args: { from: '09:00', to: '17:00' } } },
    leveled: { params: { 'env.lvl': 'int' }, expr: { attr: 'env.lvl', gte: 1 } },
  };
  const ROWS = ['d1', 'd2', 'd3', 'd4', 'd5'].map(doc);
  const tuples: Tuple[] = Object.keys(caveats).map((name, i): Tuple => ({ ...tuple(doc(`d${i + 1}`), 'viewer', user('bob')), caveat: { name } }));
  // As @spinajs/users builds it: the user model as identity, authn facts, a ceiling, a non-plain attribute.
  const session: Principal = {
    ...userPrincipal('bob'),
    identity: new UserRecord(false),
    authn: { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: NOW },
    ceiling: { permissions: ['doc:*'] },
    attributes: { team: 'core', groups: new Map([['eng', 1]]) },
  };
  let model: RebacModel;
  let authz: Authorizer;
  const check = (input: CheckInput) => authz.check(input, { cache: new Map() });

  before(async () => {
    model = await rebac(caveats, tuples);
    authz = new Authorizer({ domain: 'root', registry: new FakePermissionRegistry(INPUTS), models: [model], nativeFilters: [model.nativeFilter], conditions, clock: () => NOW });
  });

  it('the residual lists no row that depends on a function caveat, and a parameter-only caveat as the check decides it', async () => {
    for (const env of [{ ip: '10.1.2.3', lvl: 2 }, { ip: '6.6.6.6', lvl: 0 }, {}]) {
      const typeLevel = await check({ principal: session, permission: 'doc:read', resource: { type: 'doc' }, env });
      expect(typeLevel.reason?.code, JSON.stringify(env)).to.not.equal('model_error');
      for (const row of ROWS) {
        const allowed = (await check({ principal: session, permission: 'doc:read', resource: row, env })).allowed;
        const expected = row.id === 'd5' && allowed;
        expect((await listed(model, typeLevel.residual, session, row)) === true, `${row.id} ${JSON.stringify(env)}`).to.equal(expected);
      }
    }
  });

  it('resource-level checks see the full principal and env', async () => {
    const allowed = async (who: Principal, env: Record<string, unknown>) => {
      const out: string[] = [];
      for (const row of ROWS) if ((await check({ principal: who, permission: 'doc:read', resource: row, env })).allowed) out.push(row.id!);
      return out;
    };
    expect(await allowed(session, { ip: '10.1.2.3', lvl: 2 })).to.deep.equal(['d1', 'd2', 'd3', 'd4', 'd5']);
    expect(await allowed(session, { ip: '6.6.6.6', lvl: 0 })).to.deep.equal(['d3', 'd4']);
    expect(await allowed({ ...session, identity: new UserRecord(true) }, { ip: '10.1.2.3', lvl: 2 })).to.deep.equal(['d1', 'd2', 'd4', 'd5']);
  });
});

describe('authz-rebac: a parameter-only caveat in the residual', () => {
  class Flag {
    constructor(readonly at: Date) {}
  }
  const caveats: CaveatConfig = {
    unbanned: { params: { 'principal.attributes.bannedAt': 'timestamp' }, expr: { attr: 'principal.attributes.bannedAt', null: true } },
    unflagged: { params: { 'principal.attributes.flag': 'string' }, expr: { attr: 'principal.attributes.flag', null: true } },
    first_empty: { params: { 'principal.attributes.list.0': 'string' }, expr: { attr: 'principal.attributes.list.0', null: true } },
  };
  let model: RebacModel;
  let authz: Authorizer;

  before(async () => {
    model = await rebac(caveats, [
      { ...tuple(doc('d1'), 'viewer', user('bob')), caveat: { name: 'unbanned' } },
      { ...tuple(doc('d2'), 'viewer', user('bob')), caveat: { name: 'unflagged' } },
      { ...tuple(doc('d3'), 'viewer', user('bob')), caveat: { name: 'first_empty' } },
    ]);
    authz = new Authorizer({ domain: 'root', registry: new FakePermissionRegistry(INPUTS), models: [model], nativeFilters: [model.nativeFilter], conditions, clock: () => NOW });
  });

  async function paths(who: Principal, row: ResourceRef): Promise<{ check: boolean; residual: boolean }> {
    const check = (await authz.check({ principal: who, permission: 'doc:read', resource: row, env: {} }, { cache: new Map() })).allowed;
    const typeLevel = await authz.check({ principal: who, permission: 'doc:read', resource: { type: 'doc' }, env: {} }, { cache: new Map() });
    expect(typeLevel.reason?.code).to.not.equal('model_error');
    return { check, residual: (await listed(model, typeLevel.residual, who, row)) === true };
  }

  it('carries plain parameter values and decides the row as the check', async () => {
    expect(await paths(userPrincipal('bob'), doc('d1'))).to.deep.equal({ check: true, residual: true });
    expect(await paths({ ...userPrincipal('bob'), attributes: { bannedAt: '2026-01-01T00:00:00.000Z' } }, doc('d1'))).to.deep.equal({ check: false, residual: false });
  });

  it('leaves a caveat undecided when a parameter value cannot travel in the vote', async () => {
    // An undefined-valued key and a class instance: the vote copy drops or refuses both, and a null test would hold.
    expect(await paths({ ...userPrincipal('bob'), attributes: { bannedAt: undefined } }, doc('d1'))).to.deep.equal({ check: true, residual: false });
    expect(await paths({ ...userPrincipal('bob'), attributes: { flag: new Flag(NOW) } }, doc('d2'))).to.deep.include({ residual: false });
  });

  it('reads a parameter through an array element as the compiler does', async () => {
    expect(await paths({ ...userPrincipal('bob'), attributes: { list: ['x'] } }, doc('d3'))).to.deep.equal({ check: false, residual: false });
    expect(await paths({ ...userPrincipal('bob'), attributes: { list: [] } }, doc('d3'))).to.deep.equal({ check: true, residual: true });
  });

  it('leaves a caveat undecided when reading its parameter throws, without an error vote', async () => {
    const attributes = Object.defineProperty({}, 'bannedAt', {
      enumerable: true,
      get: () => {
        throw new Error('no');
      },
    });
    expect(await paths({ ...userPrincipal('bob'), attributes }, doc('d1'))).to.deep.include({ residual: false });
  });
});

describe('authz-rebac: a residual over many large parameter values', () => {
  const NAMES = Array.from({ length: 12 }, (_, i) => `l${i}`);
  const caveats: CaveatConfig = Object.fromEntries(NAMES.map((n) => [n, { params: { 'env.tag': 'string', [`principal.attributes.${n}`]: 'list<string>' }, expr: { attr: 'env.tag', in: { ref: `principal.attributes.${n}` } } }]));
  const list = Array.from({ length: 900 }, (_, i) => `t${i}`);
  const who: Principal = { ...userPrincipal('bob'), attributes: Object.fromEntries(NAMES.map((n) => [n, list])) };

  it('decides as many caveats as fit under the vote limit and leaves the others undecided', async () => {
    const model = await rebac(caveats, NAMES.map((name, i): Tuple => ({ ...tuple(doc(`d${i}`), 'viewer', user('bob')), caveat: { name } })));
    const authz = new Authorizer({ domain: 'root', registry: new FakePermissionRegistry(INPUTS), models: [model], nativeFilters: [model.nativeFilter], conditions, clock: () => NOW });
    const typeLevel = await authz.check({ principal: who, permission: 'doc:read', resource: { type: 'doc' }, env: { tag: 't1' } }, { cache: new Map() });
    expect(typeLevel.reason?.code).to.not.equal('model_error');
    const rows: string[] = [];
    for (const i of NAMES.keys()) {
      const row = doc(`d${i}`);
      if ((await listed(model, typeLevel.residual, who, row)) !== true) continue;
      expect((await authz.check({ principal: who, permission: 'doc:read', resource: row, env: { tag: 't1' } }, { cache: new Map() })).allowed, row.id).to.equal(true);
      rows.push(row.id!);
    }
    expect(rows.length).to.be.greaterThan(0).and.lessThan(NAMES.length);
  });
});
