import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import type { Principal } from '@spinajs/authz';
import { BaseController, BasePath, Get, Ok, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { linkPrincipal, testHost } from '@spinajs/authz-testing';

import { LinkPrincipalSource, LinkResolver, PrincipalSource } from '../src/index.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { registerHeaderSource } from './support/principals.js';

const calls: { token: string; companion?: Principal }[] = [];

class TestLinkResolver extends LinkResolver {
  public async principal(token: string, companion?: Principal): Promise<Principal> {
    calls.push({ token, companion });
    const p = linkPrincipal(token === 'tok-l1' ? 'l1' : 'unknown', { scope: [{ type: 'project', id: 'p1' }] });
    return companion ? { ...p, companions: [{ type: companion.type, id: companion.id }] } : p;
  }
}

@BasePath('links')
class LinkRoutes extends BaseController {
  @Get('/')
  public who(@Req() req: Request) {
    return new Ok({ principal: req.storage.Principal ?? null });
  }
}

describe('LinkPrincipalSource (B38 http)', function () {
  this.timeout(30000);

  let app: TestApp;
  let unregisterSource: () => void;

  before(async () => {
    unregisterSource = registerHeaderSource();
    DI.register(TestLinkResolver).as(LinkResolver);
    app = await startApp({ controllers: [LinkRoutes] });
  });

  after(async () => {
    await stopApp();
    DI.unregister(TestLinkResolver);
    DI.uncache(TestLinkResolver);
    DI.uncache(LinkResolver);
    unregisterSource();
  });

  beforeEach(() => {
    calls.length = 0;
  });

  afterEach(() => testHost.config().unset(['authz', 'http', 'links']));

  it('is the link source at order 110, after the authn principal', () => {
    const link = new LinkPrincipalSource();
    expect(link).to.be.instanceOf(PrincipalSource);
    expect(link).to.include({ name: 'link', order: 110 });
  });

  it('a token in the link query parameter yields the link principal', async () => {
    const res = await app.request().get('/links?link=tok-l1');

    expect(res.body.principal).to.deep.include({ type: 'link', id: 'l1' });
    expect(calls).to.deep.eq([{ token: 'tok-l1', companion: undefined }]);
  });

  it('a token in the X-Authz-Link header yields the link principal', async () => {
    const res = await app.request().get('/links').set('X-Authz-Link', 'tok-l1');

    expect(res.body.principal).to.deep.include({ type: 'link', id: 'l1' });
  });

  it('reads no cookie while authz.http.links.cookie is null, and the named cookie once configured', async () => {
    const off = await app.request().get('/links').set('Cookie', 'link=tok-l1');
    expect(off.body.principal).to.deep.include({ type: 'anonymous' });

    testHost.config().set(['authz', 'http', 'links'], { query: null, header: null, cookie: 'link' });
    const on = await app.request().get('/links').set('Cookie', 'link=tok-l1');
    expect(on.body.principal).to.deep.include({ type: 'link', id: 'l1' });
    expect((await app.request().get('/links?link=tok-l1')).body.principal).to.deep.include({ type: 'anonymous' });
  });

  it('the principal the other sources found becomes the companion of the link principal that replaces it', async () => {
    const res = await app.request().get('/links?link=tok-l1').set('x-user', 'alice');

    expect(res.body.principal).to.deep.include({ type: 'link', id: 'l1', companions: [{ type: 'user', id: 'alice' }] });
    expect(calls[0].companion).to.deep.include({ type: 'user', id: 'alice' });
  });

  it('without a token the other sources decide', async () => {
    const res = await app.request().get('/links').set('x-user', 'alice');

    expect(res.body.principal).to.deep.include({ type: 'user', id: 'alice' });
    expect(calls).to.deep.eq([]);
  });

  it('without a LinkResolver a token yields a link principal that denies everything', async () => {
    DI.unregister(TestLinkResolver);
    DI.uncache(LinkResolver);
    try {
      const res = await app.request().get('/links?link=tok-l1').set('x-user', 'alice');

      expect(res.body.principal).to.deep.include({ type: 'link', authenticated: true, companions: [{ type: 'user', id: 'alice' }] });
      expect(res.body.principal.ceiling).to.deep.eq({ resources: [], reason: 'link_invalid' });
    } finally {
      DI.register(TestLinkResolver).as(LinkResolver);
    }
  });
});
