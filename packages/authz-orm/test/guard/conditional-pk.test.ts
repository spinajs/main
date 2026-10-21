import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError, TRUE, authzStorage, runWithPrincipal } from '@spinajs/authz';
import type { Decision, Principal, ResourceFilter } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import type { ModelBase } from '@spinajs/orm';

import { AccessResource } from '../../src/index.js';
import { TestDb } from '../support/db.js';

const expect = chai.expect;

const alice: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };
const OWN: ResourceFilter = { op: 'and', args: [{ op: 'cmp', field: 'owner', cmp: 'eq', value: 'alice' }, { op: 'cmp', field: 'title', cmp: 'ne', value: 'x' }] };

type W = Promise<ModelBase[]> & { first(): Promise<ModelBase | undefined> };
type M = typeof ModelBase & { get(pk: unknown): Promise<ModelBase>; findOrFail(pks: unknown[]): Promise<ModelBase[]>; where(...a: unknown[]): W };

const decided = (residual: ResourceFilter) => ({ allowed: true, permission: 'task:read', resource: { type: 'task', id: 't1' }, residual }) as unknown as Decision;
const inRoute = <T>(decision: Decision, fn: () => Promise<T>) => authzStorage().run({ Principal: alice, AuthzDecision: decision }, fn);

const settle = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e;
  }
};

describe('authz-orm guard: single-PK loads under a route decision (M1)', function () {
  this.timeout(60000);
  let db: TestDb;
  let Task: M;

  before(async () => {
    db = await TestDb.open();
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    Task = await db.define({ name: 'Task', columns: { title: 'TEXT', owner: 'TEXT' }, rows: [{ id: 't1', title: 'a', owner: 'alice' }, { id: 't2', title: 'b', owner: 'bob' }], decorate: (c) => AccessResource('task')(c) });
    testHost.config().set(['process', 'env', 'APP_ENV'], 'test');
  });

  afterEach(async () => {
    testHost.config().unset(['process', 'env', 'APP_ENV']);
    await db.clear();
  });

  it('refuses Model.get(id) inside a route whose decision is conditional', async () => {
    const err = await inRoute(decided(OWN), () => settle(() => Task.get('t2')));

    expect(err).to.be.instanceOf(AuthzConfigError);
  });

  it('refuses the other single-PK load shapes inside a route whose decision is conditional', async () => {
    for (const load of [() => Task.where('id', 't2').first(), () => Task.findOrFail(['t2'])]) {
      expect(await inRoute(decided(OWN), () => settle(load))).to.be.instanceOf(AuthzConfigError);
    }
  });

  it('lets Model.get(id) through inside a route whose decision is unconditional', async () => {
    const row = await inRoute(decided(TRUE), () => Task.get('t2'));

    expect((row as unknown as { id: string }).id).to.equal('t2');
  });

  it('lets Model.get(id) through without a route decision, as in code outside a request', async () => {
    const row = await runWithPrincipal(alice, () => Task.get('t2'));

    expect((row as unknown as { id: string }).id).to.equal('t2');
  });
});
