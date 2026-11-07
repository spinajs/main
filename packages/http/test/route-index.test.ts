import 'mocha';
import { expect } from 'chai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DI } from '@spinajs/di';

import { BaseController, BasePath, Del, Get, Post, RouteIndex, RoutePathMatcher, buildRoutePath } from '../src/index.js';

const noopLog = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, security: () => {}, success: () => {} };

@BasePath('items')
class ItemsController extends BaseController {
  @Get(':id')
  public one() {
    return null;
  }

  @Get('special')
  public special() {
    return null;
  }

  @Post()
  public create() {
    return null;
  }

  @Del(':id')
  public remove() {
    return null;
  }
}

@BasePath('items')
class ShadowController extends BaseController {
  @Get('special')
  public special() {
    return null;
  }
}

function controller<T extends BaseController>(type: new () => T): T {
  const c = new type();
  const cfg = { get: (_path: string, fallback?: unknown) => fallback };
  for (const [name, value] of Object.entries({ _cfg: cfg, _log: noopLog, _container: DI, _actionLocalStorage: new AsyncLocalStorage() })) {
    Object.defineProperty(c, name, { value });
  }
  return c;
}

function indexOf(...controllers: BaseController[]): RouteIndex {
  const index = new RouteIndex();
  for (const c of controllers) {
    for (const [, route] of c.Descriptor.Routes) index.add(c, route, buildRoutePath(c.BasePath, route));
  }
  return index;
}

describe('RouteIndex', () => {
  const items = controller(ItemsController);

  it('matches method and mounted path as the router does: params, case, trailing slash', () => {
    const index = indexOf(items);
    const match = index.match('GET', '/items/42');
    expect(match?.controller).to.eq(items);
    expect(match?.route.Method).to.eq('one');
    expect(match?.path).to.eq('http:GET /items/:id');
    expect(index.match('get', '/ITEMS/42/')?.route.Method).to.eq('one');
    expect(index.match('POST', '/items/create')?.route.Method).to.eq('create');
    expect(index.match('DELETE', '/items/7')?.route.Method).to.eq('remove');
  });

  it('answers HEAD with the GET route, and nothing for a method or path no route serves', () => {
    const index = indexOf(items);
    expect(index.match('HEAD', '/items/1')?.route.Method).to.eq('one');
    expect(index.match('PUT', '/items/1')).to.eq(undefined);
    expect(index.match('GET', '/items/1/extra')).to.eq(undefined);
    expect(index.match('GET', '/other')).to.eq(undefined);
  });

  it('gives the route the router would serve: the first one registered', () => {
    expect(indexOf(items).match('GET', '/items/special')?.route.Method).to.eq('one');
    const shadow = controller(ShadowController);
    const index = indexOf(shadow, items);
    expect(index.match('GET', '/items/special')?.controller).to.eq(shadow);
  });

  it('matches nothing for a malformed percent-encoding the router answers 400', () => {
    expect(indexOf(items).match('GET', '/items/%E0%A4%A')).to.eq(undefined);
  });

  it('follows routes added and controllers removed after the first match', () => {
    const index = new RouteIndex();
    expect(index.match('GET', '/items/1')).to.eq(undefined);
    for (const [, route] of items.Descriptor.Routes) index.add(items, route, buildRoutePath(items.BasePath, route, 'api'));
    expect(index.match('GET', '/api/items/1')?.controller).to.eq(items);
    index.remove(items);
    expect(index.match('GET', '/api/items/1')).to.eq(undefined);
  });
});

describe('RoutePathMatcher', () => {
  it('matches a path for its method, or any method when none is given', () => {
    const m = new RoutePathMatcher<string>();
    m.add('/hooks/:provider', 'hooks');
    m.add('/only-post', 'post', 'POST');
    expect(m.match('DELETE', '/Hooks/stripe/')).to.eq('hooks');
    expect(m.match('POST', '/only-post')).to.eq('post');
    expect(m.match('GET', '/only-post')).to.eq(undefined);
    expect(m.match('POST', '/hooks/stripe/extra')).to.eq(undefined);
  });

  it('throws for a path the router cannot compile', () => {
    expect(() => new RoutePathMatcher().add('/hooks/:', true)).to.throw();
  });
});
