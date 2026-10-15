import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { AuthzConfigError, SYSTEM, authzStorage, runWithPrincipal } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import type { ModelBase } from '@spinajs/orm';

import { AccessGuardMiddleware } from '../src/guard/middleware.js';
import { guardMode } from '../src/guard/env.js';
import { ormLog } from '../src/host.js';
import { AccessListMiddleware } from '../src/lists/middleware.js';
import { AccessResource } from '../src/index.js';
import { setMarks } from '../src/marker.js';
import { TestDb } from './support/db.js';

const expect = chai.expect;

const alice: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };
type W = Promise<ModelBase[]> & { first(): Promise<ModelBase | undefined>; where(...a: unknown[]): W; orWhere(...a: unknown[]): W };
type M = typeof ModelBase & { query(): Promise<ModelBase[]> & object; where(...a: unknown[]): W };

describe('authz-orm runtime guard', function () {
  this.timeout(60000);
  let db: TestDb;
  let Task: M;
  let Plain: M;
  const appEnv = process.env.APP_ENV;

  before(async () => {
    db = await TestDb.open();
  });

  after(async () => {
    await db?.close();
    if (appEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = appEnv;
  });

  beforeEach(async () => {
    Task = (await db.define({ name: 'Task', columns: { title: 'TEXT' }, rows: [{ id: 't1', title: 'a' }, { id: 't2', title: 'b' }], decorate: (c) => AccessResource('task')(c) })) as M;
    Plain = (await db.define({ name: 'Plain', columns: { title: 'TEXT' }, rows: [{ id: 'x', title: 'b' }] })) as M;
  });

  afterEach(async () => {
    testHost.config().unset(['process', 'env', 'APP_ENV']);
    sinon.restore();
    await db.clear();
  });

  const env = (value: string) => testHost.config().set(['process', 'env', 'APP_ENV'], value);
  const as = <T>(p: Principal, fn: () => Promise<T>) => runWithPrincipal(p, fn);

  it('reads the env like authn: test throws, development warns, anything else and unset are off', () => {
    expect(guardMode()).to.equal('off');
    env('test');
    expect(guardMode()).to.equal('throw');
    env('production');
    expect(guardMode()).to.equal('off');
    env('development');
    delete process.env.APP_ENV;
    expect(guardMode(), 'development that no source named is a fallback, so unset').to.equal('off');
    process.env.APP_ENV = 'development';
    expect(guardMode()).to.equal('warn');
  });

  it('in test, a select of an @AccessResource model without the helper is an AuthzConfigError', async () => {
    env('test');
    let err: unknown;
    try {
      await as(alice, async () => await Task.query());
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(AuthzConfigError);
    expect((err as Error).message).to.match(/\.accessible\(permission\), \.unscoped\(reason\) or runAs\(SYSTEM\)/);
  });

  it('lets through SYSTEM, marked builders, route @Unscoped, plain models and writes', async () => {
    env('test');
    expect(await runWithPrincipal(SYSTEM, async () => (await Task.query()).length)).to.equal(2);
    expect(await as(alice, async () => (await Plain.query()).length)).to.equal(1);
    const q = Task.query();
    setMarks(q, { unscoped: 'export' });
    expect(await as(alice, async () => (await q).length)).to.equal(2);
    // The guard alone is under test here: the list middleware would plan this builder against a booted authz host.
    sinon.stub(AccessListMiddleware.prototype, 'beforeQueryExecution').resolves();
    const r = Task.query();
    setMarks(r, { accessible: 'task:read' });
    expect(await as(alice, async () => (await r).length)).to.equal(2);
    await authzStorage().run({ Principal: alice, Unscoped: 'route' } as never, async () => {
      expect((await Task.query()).length).to.equal(2);
    });
  });

  it('in development, warns once per call site', async () => {
    env('development');
    process.env.APP_ENV = 'development';
    const warn = sinon.stub(ormLog(), 'warn');
    for (let i = 0; i < 3; i++) await as(alice, async () => await Task.query());
    await as(alice, async () => await Task.query());
    expect(warn.callCount).to.equal(2);
    expect(String(warn.firstCall.args[0])).to.match(/guard\.test\.ts/);
  });

  it('does not flag single-object loads by primary key', async () => {
    env('test');
    const T = Task as M & { get(pk: unknown): Promise<ModelBase>; findOrFail(pks: unknown[]): Promise<ModelBase[]> };
    expect(await as(alice, async () => ((await Task.where('id', 't1').first()) as unknown as { id: string }).id)).to.equal('t1');
    expect(await as(alice, async () => ((await T.get('t1')) as unknown as { id: string }).id)).to.equal('t1');
    expect(await as(alice, async () => (await T.findOrFail(['t1'])).length)).to.equal(1);
  });

  it('flags a select that is not exactly one primary-key equality', async () => {
    env('test');
    const T = Task as M & { findOrFail(pks: unknown[]): Promise<ModelBase[]> };
    const attempts: (() => Promise<unknown>)[] = [
      async () => await Task.where('title', 'a').first(),
      async () => await Task.where('id', 't1').orWhere('title', 'b'),
      async () => await Task.where('id', 't1').where('title', 'a'),
      async () => await T.findOrFail(['t1', 't2']),
      async () => await Task.where('id', '!=', 't1'),
    ];
    for (const [i, attempt] of attempts.entries()) {
      let err: unknown;
      try {
        await as(alice, attempt);
      } catch (e) {
        err = e;
      }
      expect(err, `attempt ${i}`).to.be.instanceOf(AuthzConfigError);
    }
  });

  it('is off in production', async () => {
    env('production');
    expect(await as(alice, async () => (await Task.query()).length)).to.equal(2);
  });

  it('is a QueryMiddleware at order 95', () => {
    expect(new AccessGuardMiddleware().order).to.equal(95);
  });
});
