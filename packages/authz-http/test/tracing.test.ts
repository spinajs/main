import 'mocha';
import { expect } from 'chai';
import { SpanStatusCode } from '@opentelemetry/api';
import type { DecisionRequest } from '@spinajs/authz';
import type { ScriptedVote } from '@spinajs/authz-testing';
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import { useInMemorySpans } from '@spinajs/tracing/testing';
import type { InMemorySpans, SpanTreeNode } from '@spinajs/tracing/testing';

import { Access } from '../src/index.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { createDomain } from './support/domain.js';
import type { TestDomain } from './support/domain.js';
import { registerHeaderSource } from './support/principals.js';

const D = 'trc';
const LOCKED = { code: 'locked', priority: 50 };

const votes = (req: DecisionRequest): ScriptedVote => (req.principal.id === 'alice' ? { permitWhen: { op: 'true' } } : { denyWhen: { op: 'true' }, denies: [{ when: { op: 'true' }, reason: LOCKED }] });

@BasePath('trc')
class InvoicesController extends BaseController {
  @Get('invoices')
  @Access('invoice:read', { domain: D })
  public list() {
    return new Ok([]);
  }
}

const child = (node: SpanTreeNode, name: string): SpanTreeNode => {
  const found = node.children.find((n) => n.span.name === name);
  if (!found) throw new Error(`${node.span.name} has no child ${name}; children: ${node.children.map((n) => n.span.name).join(', ')}`);
  return found;
};

const serverSpan = (spans: InMemorySpans): SpanTreeNode => {
  const root = spans.tree().find((n) => n.span.name === 'GET /trc/invoices');
  if (!root) throw new Error('no GET /trc/invoices root span');
  return root;
};

describe('@Access span tree', function () {
  this.timeout(30000);

  let app: TestApp;
  let domain: TestDomain;
  let unregisterSource: () => void;
  let spans: InMemorySpans;

  before(async () => {
    unregisterSource = registerHeaderSource();
    app = await startApp({ controllers: [InvoicesController] });
    domain = await createDomain(D, { permissions: { 'invoice:read': {} }, model: { votes } });
  });

  after(async () => {
    await domain?.dispose();
    await stopApp();
    unregisterSource();
  });

  beforeEach(() => {
    spans = useInMemorySpans();
  });

  afterEach(() => spans.detach());

  it('nests authz.check under the AccessPolicy span, with the route span after the policy', async () => {
    expect((await app.request().get('/trc/invoices').set('x-user', 'alice')).status).to.eq(200);
    await spans.waitFor('GET /trc/invoices');

    const root = serverSpan(spans);
    const names = root.children.map((n) => n.span.name);
    expect(names.indexOf('policy AccessPolicy')).to.be.within(0, names.indexOf('route InvoicesController.list') - 1);

    const check = child(child(root, 'policy AccessPolicy'), 'authz.check');
    expect(check.span.attributes).to.include({
      'spina.authz.domain': D,
      'spina.authz.permission': 'invoice:read',
      'spina.authz.resource': 'invoice',
      'spina.principal.id': 'user:alice',
      'spina.authz.allowed': true,
    });
  });

  it('puts the deny reason on authz.check and the ERROR status on the policy span only', async () => {
    expect((await app.request().get('/trc/invoices').set('x-user', 'carol')).status).to.eq(403);
    await spans.waitFor('GET /trc/invoices');

    const root = serverSpan(spans);
    expect(root.children.map((n) => n.span.name)).to.not.include('route InvoicesController.list');

    const policy = child(root, 'policy AccessPolicy');
    const check = child(policy, 'authz.check');
    expect(check.span.attributes).to.include({ 'spina.authz.allowed': false, 'spina.authz.reason': 'locked' });
    expect(check.span.status.code).to.eq(SpanStatusCode.UNSET);
    expect(policy.span.status.code).to.eq(SpanStatusCode.ERROR);
  });
});
