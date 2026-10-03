import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { DI } from '@spinajs/di';
import type { DecisionRequest } from '@spinajs/authz';
import { Log } from '@spinajs/log';
import type { ScriptedVote } from '@spinajs/authz-testing';
import { ControllerSource } from '@spinajs/http';

import { ExplainControllerSource } from '../src/index.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { createDomain } from './support/domain.js';
import type { TestDomain } from './support/domain.js';
import { registerHeaderSource } from './support/principals.js';

const D = 'exp';
const EXPLAIN = '/authz/explain?principal=user:alice&permission=file:read&resource=file:f1';

// bob holds authz:explain, carol only on a condition; nobody holds file:read.
const votes = (req: DecisionRequest): ScriptedVote =>
  req.permission !== 'authz:explain' ? {} : req.principal.id === 'bob' ? { permitWhen: { op: 'true' } } : req.principal.id === 'carol' ? { permitWhen: { op: 'cmp', field: 'x', cmp: 'eq', value: 1 } } : {};

async function boot(config: Record<string, unknown>): Promise<{ app: TestApp; domain: TestDomain }> {
  const app = await startApp({ config: { 'authz.http.access': { domain: D }, ...config } });
  const domain = await createDomain(D, { permissions: { 'file:read': {}, 'authz:explain': {} }, model: { votes } });
  return { app, domain };
}

describe('explain route (H19, B41)', function () {
  this.timeout(30000);

  let unregisterSource: () => void;
  let running: { app: TestApp; domain: TestDomain } | undefined;

  before(() => {
    unregisterSource = registerHeaderSource();
  });

  afterEach(async () => {
    await running?.domain.dispose();
    running = undefined;
    await stopApp();
  });

  after(() => unregisterSource());

  it('outside production the enabled route answers the decision with its trace', async () => {
    running = await boot({ 'authz.http.explainRoute': { enabled: true, permission: 'authz:explain' }, 'configuration.isProduction': false });

    const res = await running.app.request().get(EXPLAIN).set('x-user', 'bob');

    expect(res.status).to.eq(200);
    expect(res.body).to.deep.include({ allowed: false, permission: 'file:read', resource: { type: 'file', id: 'f1' }, principal: { type: 'user', id: 'alice' } });
    expect(res.body.trace).to.be.an('object');
  });

  it('refuses a caller without the explain permission (403) and an anonymous one (401)', async () => {
    running = await boot({ 'authz.http.explainRoute': { enabled: true, permission: 'authz:explain' }, 'configuration.isProduction': false });

    expect((await running.app.request().get(EXPLAIN).set('x-user', 'alice')).status).to.eq(403);
    expect((await running.app.request().get(EXPLAIN)).status).to.eq(401);
    expect((await running.app.request().get(EXPLAIN).set('x-user', 'carol')).status, 'a conditional grant').to.eq(403);
  });

  it('refuses a malformed principal or permission with 400', async () => {
    running = await boot({ 'authz.http.explainRoute': { enabled: true, permission: 'authz:explain' }, 'configuration.isProduction': false });

    expect((await running.app.request().get('/authz/explain?principal=alice&permission=file:read').set('x-user', 'bob')).status).to.eq(400);
    expect((await running.app.request().get('/authz/explain?principal=user:alice&permission=bad').set('x-user', 'bob')).status).to.eq(400);
  });

  it('is not registered while disabled (404)', async () => {
    running = await boot({ 'configuration.isProduction': false });

    expect((await running.app.request().get(EXPLAIN).set('x-user', 'bob')).status).to.eq(404);
  });

  it('is never registered in production, even when enabled (404), and boot warns about it', async () => {
    const sources = (await DI.resolve(Array.ofType(ControllerSource))) as ControllerSource[];
    const source = sources.find((s) => s instanceof ExplainControllerSource) as unknown as { Log: Log };
    const warn = sinon.spy();
    const stub = sinon.stub(source.Log, 'warn').callsFake(warn);
    try {
      running = await boot({ 'authz.http.explainRoute': { enabled: true, permission: 'authz:explain' }, 'configuration.isProduction': true });
    } finally {
      stub.restore();
    }

    expect((await running.app.request().get(EXPLAIN).set('x-user', 'bob')).status).to.eq(404);
    expect(warn.calledWithMatch(/explainRoute\.enabled is true in production/)).to.eq(true);
  });
});
