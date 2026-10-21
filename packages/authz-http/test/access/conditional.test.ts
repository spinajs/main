import 'mocha';
import { expect } from 'chai';
import type { DecisionRequest, ResourceRef } from '@spinajs/authz';
import { BaseController, BasePath, Get, Ok, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { FakeAdapter } from '@spinajs/authz-testing';
import type { FakeRow, ScriptedVote } from '@spinajs/authz-testing';

import { Access, typedExtractor } from '../../src/index.js';
import { startApp, stopApp } from '../support/app.js';
import type { TestApp } from '../support/app.js';
import { createDomain } from '../support/domain.js';
import type { TestDomain } from '../support/domain.js';
import { registerHeaderSource } from '../support/principals.js';

const D = 'cond';
const byParam = (type: string) => typedExtractor(type, (req) => ({ type, id: req.params.id }));

const permissions = { 'invoice:read': {}, 'invoice:edit': {}, 'memo:read': {} };
const rows = { invoice: [{ id: 'i1', owner: 'alice' }, { id: 'i2', owner: 'bob' }] };

// carol reads every invoice; everyone else reads and edits own invoices and memos only (a residual).
const votes = (req: DecisionRequest): ScriptedVote => {
  if (req.principal.id === 'carol') return { permitWhen: { op: 'true' } };
  return { permitWhen: { op: 'cmp', field: 'owner', cmp: 'eq', value: req.principal.id } };
};

class CountingAdapter extends FakeAdapter {
  public readonly loads: ResourceRef[] = [];

  public override async load(ref: ResourceRef): Promise<FakeRow | null> {
    this.loads.push(ref);
    return super.load(ref);
  }
}

const decision = (req: Request) => new Ok({ allowed: req.storage.AuthzDecision?.allowed ?? null, residual: req.storage.AuthzDecision?.residual.op ?? null });

@BasePath('cond')
class ConditionalRoutes extends BaseController {
  @Get('invoices/:id')
  @Access('invoice:read', { domain: D, resource: byParam('invoice') })
  public byDefault(@Req() req: Request) {
    return decision(req);
  }

  @Get('legacy/:id')
  @Access('invoice:read', { domain: D, resource: byParam('invoice'), subject: 'load' })
  public legacy(@Req() req: Request) {
    return decision(req);
  }

  @Get('action/:id')
  @Access('invoice:read', { domain: D, resource: byParam('invoice'), conditional: 'action' })
  public action(@Req() req: Request) {
    return decision(req);
  }

  @Get('memos/:id')
  @Access('memo:read', { domain: D, resource: byParam('memo') })
  public memo(@Req() req: Request) {
    return decision(req);
  }

  @Get('invoices')
  @Access('invoice:read', { domain: D })
  public list(@Req() req: Request) {
    return decision(req);
  }

  @Get('either/:id')
  @Access(['invoice:edit', 'invoice:read'], { domain: D, resource: byParam('invoice') })
  public either(@Req() req: Request) {
    return decision(req);
  }
}

describe('AccessPolicy conditional allow (M1)', function () {
  this.timeout(30000);

  let app: TestApp;
  let domain: TestDomain;
  let adapter: CountingAdapter;
  let unregisterSource: () => void;

  before(async () => {
    unregisterSource = registerHeaderSource();
    app = await startApp({ controllers: [ConditionalRoutes] });
    adapter = new CountingAdapter({ types: ['invoice'], rows });
    domain = await createDomain(D, { permissions, model: { votes }, adapters: [adapter] });
  });

  after(async () => {
    await domain?.dispose();
    await stopApp();
    unregisterSource();
  });

  beforeEach(() => {
    adapter.loads.length = 0;
  });

  const get = (path: string, user: string) => app.request().get(`/cond/${path}`).set('x-user', user);

  it("by default denies a conditional allow on another owner's row, with the reason of the check against the row", async () => {
    const res = await get('invoices/i2', 'alice');

    expect(res.status).to.eq(403);
    expect(res.body).to.have.nested.property('reason.code', 'residual_false');
    expect(adapter.loads).to.deep.eq([{ type: 'invoice', id: 'i2' }]);
  });

  it('by default lets the owner through with a definite decision in req.storage.AuthzDecision', async () => {
    const res = await get('invoices/i1', 'alice');

    expect(res.status).to.eq(200);
    expect(res.body).to.deep.eq({ allowed: true, residual: 'true' });
  });

  it("subject: 'load' still means conditional: 'load'", async () => {
    expect((await get('legacy/i2', 'alice')).status).to.eq(403);
    expect((await get('legacy/i1', 'alice')).body).to.deep.eq({ allowed: true, residual: 'true' });
  });

  it("conditional: 'action' lets the conditional allow through with its residual and loads nothing", async () => {
    const res = await get('action/i2', 'alice');

    expect(res.status).to.eq(200);
    expect(res.body).to.deep.eq({ allowed: true, residual: 'cmp' });
    expect(adapter.loads).to.have.length(0);
  });

  it('denies a conditional allow on a type no ResourceAdapter can load with unknown_resource', async () => {
    const res = await get('memos/m1', 'alice');

    expect(res.status).to.eq(403);
    expect(res.body).to.deep.include({ reason: { code: 'unknown_resource' } });
  });

  it('denies a missing row with unknown_resource', async () => {
    const res = await get('invoices/missing', 'alice');

    expect(res.status).to.eq(403);
    expect(res.body).to.have.nested.property('reason.code', 'unknown_resource');
  });

  it('leaves a type-level conditional allow to the action and loads nothing', async () => {
    const res = await get('invoices', 'alice');

    expect(res.status).to.eq(200);
    expect(res.body).to.deep.eq({ allowed: true, residual: 'cmp' });
    expect(adapter.loads).to.have.length(0);
  });

  it('loads nothing for an unconditional allow', async () => {
    const res = await get('invoices/i2', 'carol');

    expect(res.status).to.eq(200);
    expect(res.body).to.deep.eq({ allowed: true, residual: 'true' });
    expect(adapter.loads).to.have.length(0);
  });

  it('loads the row once for several conditional permissions of one @Access', async () => {
    expect((await get('either/i2', 'alice')).status).to.eq(403);
    expect(adapter.loads).to.have.length(1);

    expect((await get('either/i1', 'alice')).body).to.deep.eq({ allowed: true, residual: 'true' });
  });
});
