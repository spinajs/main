import 'mocha';
import { expect } from 'chai';
import express from 'express';

import { BasePath, BaseController, Del, Get, Post, RouteIndex, RoutePathMatcher, checkRouterInternals } from '../src/index.js';
import { controller, mountRoutes } from './support/route-index.js';

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

function indexOf(...controllers: BaseController[]): RouteIndex {
  const index = new RouteIndex();
  mountRoutes(index, controllers);
  return index;
}

const names = (matches: readonly { controller: object; route: { Method: string | symbol } }[]) => matches.map((m) => `${m.controller.constructor.name}.${String(m.route.Method)}`);

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

  it('gives the route the router serves: the first one mounted, whatever order the routes were added in', () => {
    expect(indexOf(items).match('GET', '/items/special')?.route.Method).to.eq('one');
    const shadow = controller(ShadowController);
    expect(indexOf(shadow, items).match('GET', '/items/special')?.controller).to.eq(shadow);

    // routes added B then A, routers mounted A then B: the router order wins
    const index = new RouteIndex();
    const root = express.Router();
    index.mount(root);
    const a = express.Router();
    const b = express.Router();
    const [, shadowRoute] = [...shadow.Descriptor.Routes][0];
    const [, itemRoute] = [...items.Descriptor.Routes][0];
    const bRoute = b.route('/items/special');
    bRoute.get((_req, _res, next) => next());
    index.add(bRoute, shadow, shadowRoute, '/items/special');
    const aRoute = a.route('/items/:id');
    aRoute.get((_req, _res, next) => next());
    index.add(aRoute, items, itemRoute, '/items/:id');
    root.use(a);
    root.use(b);
    index.mounted();
    expect(index.match('GET', '/items/special')?.controller).to.eq(items);
  });

  it('lists every mounted route that could serve a request, in router order', () => {
    const shadow = controller(ShadowController);
    const index = indexOf(shadow, items);
    expect(names(index.matchAll('GET', '/items/special'))).to.deep.eq(['ShadowController.special', 'ItemsController.one', 'ItemsController.special']);
    expect(index.matchAll('GET', '/nowhere')).to.deep.eq([]);
    expect(names(index.all())).to.deep.eq(['ShadowController.special', 'ItemsController.one', 'ItemsController.special', 'ItemsController.create', 'ItemsController.remove']);
  });

  it('matches nothing for a malformed percent-encoding the router answers 400', () => {
    const index = indexOf(items);
    expect(index.match('GET', '/items/%E0%A4%A')).to.eq(undefined);
    expect(index.matchAll('GET', '/items/%E0%A4%A')).to.deep.eq([]);
  });

  it('gives nothing for a route mounted outside it, rather than a later one', () => {
    const unknownFirst = new RouteIndex();
    const unknownRoot = express.Router();
    unknownFirst.mount(unknownRoot);
    unknownRoot.get('/items/special', (_req, _res, next) => next());
    const known = express.Router();
    const [, route] = [...items.Descriptor.Routes][0];
    const r = known.route('/items/:id');
    r.get((_req, _res, next) => next());
    unknownFirst.add(r, items, route, '/items/:id');
    unknownRoot.use(known);
    expect(unknownFirst.match('GET', '/items/special')).to.eq(undefined);
    expect(unknownFirst.matchAll('GET', '/items/special')).to.deep.eq([]);
    expect(unknownFirst.match('GET', '/items/1')?.controller).to.eq(items);
  });

  it('keeps one controllers router: the same one again changes nothing, a new one (a re-resolve) replaces it', () => {
    const index = indexOf(items);
    const version = index.version;
    const fresh = express.Router();
    index.mount(fresh);
    expect(index.version).to.not.eq(version);
    expect(index.match('GET', '/items/1')).to.eq(undefined);
    const replaced = index.version;
    index.mount(fresh);
    expect(index.version).to.eq(replaced);
  });

  it('tells routes added without a mounted router apart', () => {
    const index = new RouteIndex();
    expect(index.unmounted).to.eq(false);
    const [, route] = [...items.Descriptor.Routes][0];
    index.add(express.Router().route('/items/:id'), items, route, '/items/:id');
    expect(index.unmounted).to.eq(true);
    index.mount(express.Router());
    expect(index.unmounted).to.eq(false);
  });

  it('matches a controller mounted after the first match, and changes its version', () => {
    const index = new RouteIndex();
    const before = index.version;
    expect(index.match('GET', '/api/items/1')).to.eq(undefined);
    mountRoutes(index, [items], 'api');
    expect(index.version).to.not.eq(before);
    expect(index.match('GET', '/api/items/1')?.controller).to.eq(items);
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

  it('throws for a path the router cannot compile, and for a method it does not route, instead of matching every method', () => {
    expect(() => new RoutePathMatcher().add('/hooks/:', true)).to.throw();
    expect(() => new RoutePathMatcher().add('/hooks', true, 'FILE')).to.throw('FILE');
  });
});

describe('Express router internals the lookups rely on', () => {
  it('are there: router.stack, layer.match, route._handlesMethod, HEAD served by GET, case and trailing slash ignored', () => {
    expect(() => checkRouterInternals()).to.not.throw();
    const router = express.Router();
    router.route('/a/:b').get((_req, _res, next) => next());
    const [layer] = (router as unknown as { stack: { match(p: string): boolean; route: { _handlesMethod(m: string): boolean } }[] }).stack;
    expect(layer.match('/A/x/')).to.eq(true);
    expect(layer.route._handlesMethod('HEAD')).to.eq(true);
    expect(layer.route._handlesMethod('POST')).to.eq(false);
    expect(layer.match('/a/x/y')).to.eq(false);
  });
});
