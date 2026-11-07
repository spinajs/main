import 'mocha';
import { expect } from 'chai';
import { Intl } from '@spinajs/intl';
import { BadRequest, Forbidden } from '@spinajs/exceptions';
import type { TestApp } from '@spinajs/testing';
import { SpanStatusCode } from '@opentelemetry/api';
import { useInMemorySpans } from '@spinajs/tracing/testing';
import type { InMemorySpans, SpanTreeNode } from '@spinajs/tracing/testing';

import { httpApp, req } from './common.js';
import { BaseController, BasePath, BasePolicy, Controllers, Get, HttpServer, Ok, Policy } from '../src/index.js';

class AllowPolicy extends BasePolicy {
  public isEnabled() {
    return true;
  }

  public async execute() {}
}

class DenyPolicy extends BasePolicy {
  public isEnabled() {
    return true;
  }

  public async execute() {
    throw new Forbidden('denied by DenyPolicy');
  }
}

@BasePath('tracing-t3')
class GuardedController extends BaseController {
  @Get()
  @Policy(AllowPolicy)
  public open() {
    return new Ok({ ok: true });
  }

  @Get()
  @Policy(DenyPolicy)
  public closed() {
    return new Ok({ ok: true });
  }

  @Get()
  public broken() {
    throw new Error('broken');
  }

  @Get()
  public invalid() {
    throw new BadRequest('invalid input');
  }
}

const rootNamed = (tree: SpanTreeNode[], name: string): SpanTreeNode => {
  const root = tree.find((n) => n.span.name === name);
  if (!root) throw new Error(`no root span ${name}; roots: ${tree.map((n) => n.span.name).join(', ')}`);
  return root;
};

describe('route and policy spans', function () {
  this.timeout(15000);

  let app: TestApp;
  let spans: InMemorySpans;

  before(async () => {
    app = await httpApp({ register: (c) => c.register(GuardedController).as(BaseController), resolve: [Intl, Controllers] });
    await (await app.resolve(HttpServer)).start();
  });

  after(() => app.dispose());

  beforeEach(() => {
    spans = useInMemorySpans();
  });

  afterEach(() => spans.detach());

  it('runs each policy in its own span and the action in a route span after it, both under the server span', async () => {
    expect((await req().get('tracing-t3/open')).status).to.eq(200);
    await spans.waitFor('GET /tracing-t3/open');

    const root = rootNamed(spans.tree(), 'GET /tracing-t3/open');
    expect(root.children.map((n) => n.span.name)).to.deep.eq(['policy AllowPolicy', 'route GuardedController.open']);
    const [policy, route] = root.children;
    expect(policy.span.attributes).to.include({ 'spina.policy.name': 'AllowPolicy', 'spina.policy.result': 'allow' });
    expect(route.span.attributes).to.include({ 'spina.route.controller': 'GuardedController', 'spina.route.action': 'open' });
    expect(route.span.status.code).to.eq(SpanStatusCode.UNSET);
  });

  it('marks a refusing policy span ERROR, starts no route span and leaves the 403 server span unset', async () => {
    expect((await req().get('tracing-t3/closed')).status).to.eq(403);
    await spans.waitFor('GET /tracing-t3/closed');

    const root = rootNamed(spans.tree(), 'GET /tracing-t3/closed');
    expect(root.children.map((n) => n.span.name)).to.deep.eq(['policy DenyPolicy']);
    const [policy] = root.children;
    expect(policy.span.attributes['spina.policy.result']).to.eq('deny');
    expect(policy.span.status.code).to.eq(SpanStatusCode.ERROR);
    expect(root.span.status.code).to.eq(SpanStatusCode.UNSET);
  });

  it('marks the route span ERROR when the action throws', async () => {
    expect((await req().get('tracing-t3/broken')).status).to.eq(500);
    await spans.waitFor('GET /tracing-t3/broken');

    const [route] = spans.byName('route GuardedController.broken');
    expect(route.status).to.deep.eq({ code: SpanStatusCode.ERROR, message: 'broken' });
    expect(route.events.map((e) => e.name)).to.deep.eq(['exception']);
  });

  it('records a 4xx the action throws on the route span without ERROR', async () => {
    expect((await req().get('tracing-t3/invalid')).status).to.eq(400);
    await spans.waitFor('GET /tracing-t3/invalid');

    const [route] = spans.byName('route GuardedController.invalid');
    expect(route.status.code).to.eq(SpanStatusCode.UNSET);
    expect(route.events.map((e) => e.name)).to.deep.eq(['exception']);
  });
});
