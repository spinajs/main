import 'mocha';
import { expect } from 'chai';
import { InvalidArgument } from '@spinajs/exceptions';
import type { Principal } from '@spinajs/authz';
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { Model, ModelBase, Primary } from '@spinajs/orm';
import { testHost } from '@spinajs/authz-testing';

import { Access, CurrentPrincipal, extractorInfo, fromBody, fromModel, fromParam, fromQuery } from '../src/index.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { createDomain } from './support/domain.js';
import type { TestDomain } from './support/domain.js';
import { registerHeaderSource } from './support/principals.js';

@Model('documents')
class Document extends ModelBase {
  @Primary()
  public Id: string;
}

const req = (r: { params?: Record<string, unknown>; body?: unknown; query?: Record<string, unknown> }) => r as unknown as Request;

describe('resource extractors', () => {
  it('fromParam reads a url parameter, and records `by` for swagger', async () => {
    expect(await fromParam('id', 'file')(req({ params: { id: 'f1' } }))).to.deep.eq({ type: 'file', id: 'f1' });
    expect(await fromParam('id', 'file')(req({ params: { id: 5 } }))).to.deep.eq({ type: 'file', id: '5' });
    const byUuid = fromParam('uuid', 'user', { by: 'Uuid' });
    expect(await byUuid(req({ params: { uuid: 'u-1' } }))).to.deep.eq({ type: 'user', id: 'u-1' });
    expect(extractorInfo(byUuid)).to.deep.eq({ type: 'user', from: 'param', name: 'uuid', by: 'Uuid' });
  });

  it('fromBody reads a dotted path of the body', async () => {
    const e = fromBody('project.id', 'project');
    expect(await e(req({ body: { project: { id: 'p1' } } }))).to.deep.eq({ type: 'project', id: 'p1' });
    expect(extractorInfo(e)).to.deep.include({ type: 'project', from: 'body', name: 'project.id' });
  });

  it('fromQuery reads a query parameter', async () => {
    expect(await fromQuery('org', 'org')(req({ query: { org: 'o1' } }))).to.deep.eq({ type: 'org', id: 'o1' });
  });

  it('refuses a missing, empty, non-scalar or inherited value with InvalidArgument (400)', () => {
    expect(() => fromParam('id', 'file')(req({ params: {} }))).to.throw(InvalidArgument);
    expect(() => fromQuery('org', 'org')(req({ query: { org: '' } }))).to.throw(InvalidArgument);
    expect(() => fromQuery('org', 'org')(req({ query: { org: ['a', 'b'] } }))).to.throw(InvalidArgument);
    expect(() => fromBody('project.id', 'project')(req({ body: { project: { id: { $ne: 1 } } } }))).to.throw(InvalidArgument);
    expect(() => fromBody('constructor.name', 'project')(req({ body: {} }))).to.throw(InvalidArgument);
  });

  it('fromModel yields an unloaded instance holding the parameter as its primary key', async () => {
    const e = fromModel(Document, 'doc');
    const instance = (await e(req({ params: { doc: 'd1' } }))) as Document;

    expect(instance).to.be.instanceOf(Document);
    expect(instance.PrimaryKeyValue).to.eq('d1');
    expect(extractorInfo(e)).to.deep.include({ from: 'model', name: 'doc', model: Document });
    expect(extractorInfo(e)).to.not.have.property('type');
  });
});

@BasePath('extract')
class ExtractRoutes extends BaseController {
  @Get('who')
  public who(@CurrentPrincipal() principal: Principal) {
    return new Ok({ principal });
  }

  @Get('files')
  @Access('file:read', { domain: 'ext', resource: fromQuery('id', 'file') })
  public file() {
    return new Ok();
  }
}

describe('@CurrentPrincipal and extractors in requests', function () {
  this.timeout(30000);

  let app: TestApp;
  let domain: TestDomain;
  let unregisterSource: () => void;

  before(async () => {
    unregisterSource = registerHeaderSource();
    app = await startApp({ controllers: [ExtractRoutes] });
    domain = await createDomain('ext', { permissions: { 'file:read': {} }, model: { votes: { 'file:read': { permitWhen: { op: 'true' } } } } });
  });

  after(async () => {
    await domain?.dispose();
    await stopApp();
    unregisterSource();
  });

  it('@CurrentPrincipal() is the request principal', async () => {
    expect((await app.request().get('/extract/who').set('x-user', 'alice')).body.principal).to.deep.include({ type: 'user', id: 'alice' });
    expect((await app.request().get('/extract/who')).body.principal).to.deep.include({ type: 'anonymous' });
  });

  it('@CurrentPrincipal() is UNATTENDED without any principal', async () => {
    testHost.config().set(['authz', 'principals', 'anonymous', 'enabled'], false);
    try {
      expect((await app.request().get('/extract/who')).body.principal).to.deep.include({ type: 'unattended' });
    } finally {
      testHost.config().set(['authz', 'principals', 'anonymous', 'enabled'], true);
    }
  });

  it('a route whose extractor finds no id answers 400', async () => {
    expect((await app.request().get('/extract/files?id=f1').set('x-user', 'alice')).status).to.eq(200);
    expect((await app.request().get('/extract/files').set('x-user', 'alice')).status).to.eq(400);
    expect(domain.model.requests.map((r) => r.resource)).to.deep.eq([{ type: 'file', id: 'f1' }]);
  });
});
