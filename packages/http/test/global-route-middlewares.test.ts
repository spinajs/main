import 'mocha';
import { expect } from 'chai';
import { Intl } from '@spinajs/intl';
import { DI, Injectable, NewInstance } from '@spinajs/di';
import { InvalidOption } from '@spinajs/exceptions';
import type { Configuration } from '@spinajs/configuration';
import type { TestApp } from '@spinajs/testing';
import type * as express from 'express';

import { httpApp, req, TestConfiguration } from './common.js';
import { BaseController, BasePath, Controllers, Get, HttpServer, Middleware, Ok, RouteMiddleware, resolveGlobalRouteMiddlewares } from '../src/index.js';
import type { GlobalRouteMiddlewareEntry, IRoute, MiddlewareStage } from '../src/index.js';

function trace(res: express.Response, label: string): void {
  const labels = [...((res.locals.globalMwTrace as string[] | undefined) ?? []), label];
  res.locals.globalMwTrace = labels;
  res.setHeader('x-mw', labels.join(','));
}

@Injectable(RouteMiddleware)
class GlobalByName extends RouteMiddleware {
  public static readonly instances = new Set<RouteMiddleware>();
  public static readonly paths: string[] = [];

  public onRegister(_route: IRoute, path: string): void {
    GlobalByName.instances.add(this);
    GlobalByName.paths.push(path);
  }

  public async onBefore(_req: express.Request, res: express.Response): Promise<void> {
    trace(res, 'name');
  }
}

class GlobalByClass extends RouteMiddleware {
  public async onBefore(_req: express.Request, res: express.Response): Promise<void> {
    trace(res, 'class');
  }
}

// NewInstance: one instance per route would show here if the entry were resolved per route
@NewInstance()
@Injectable(RouteMiddleware)
class GlobalWithOptions extends RouteMiddleware {
  public static created = 0;

  constructor(protected label: string) {
    super();
    GlobalWithOptions.created++;
  }

  public async onBefore(_req: express.Request, res: express.Response): Promise<void> {
    trace(res, `options:${this.label}`);
  }
}

class GlobalOuter extends RouteMiddleware {
  public override readonly Stage: MiddlewareStage = 'outer';

  public async onBefore(_req: express.Request, res: express.Response): Promise<void> {
    trace(res, 'global-outer');
  }
}

class GlobalSkippable extends RouteMiddleware {
  public static readonly paths: string[] = [];

  public override isEnabled(route: IRoute): boolean {
    return route.Method !== 'skipped';
  }

  public onRegister(_route: IRoute, path: string): void {
    GlobalSkippable.paths.push(path);
  }

  public async onBefore(_req: express.Request, res: express.Response): Promise<void> {
    trace(res, 'skippable');
  }
}

class ControllerOuter extends RouteMiddleware {
  public override readonly Stage: MiddlewareStage = 'outer';

  public async onBefore(_req: express.Request, res: express.Response): Promise<void> {
    trace(res, 'controller-outer');
  }
}

class ControllerInner extends RouteMiddleware {
  public async onBefore(_req: express.Request, res: express.Response): Promise<void> {
    trace(res, 'controller');
  }
}

class RouteInner extends RouteMiddleware {
  public async onBefore(_req: express.Request, res: express.Response): Promise<void> {
    trace(res, 'route');
  }
}

class NotAMiddleware {}

@BasePath('global-mw')
@Middleware(ControllerOuter)
@Middleware(ControllerInner)
class GlobalMwController extends BaseController {
  @Get()
  @Middleware(RouteInner)
  public ordered() {
    return new Ok({ ok: true });
  }

  @Get()
  public skipped() {
    return new Ok({ ok: true });
  }
}

@BasePath('global-plain')
class GlobalPlainController extends BaseController {
  @Get()
  public plain() {
    return new Ok({ ok: true });
  }

  @Get()
  public other() {
    return new Ok({ ok: true });
  }
}

function configWith(middlewares: unknown[]) {
  return class extends TestConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();
      (this.Config as { http: Record<string, unknown> }).http.routes = { middlewares };
    }
  };
}

function cfgOf(middlewares: unknown[]): Configuration {
  return { get: (path: string, fallback?: unknown) => (path === 'http.routes.middlewares' ? middlewares : fallback) } as unknown as Configuration;
}

function headerOf(res: unknown, name: string): string | undefined {
  return (res as { header: Record<string, string | undefined> }).header[name];
}

function routeDuration(header: string | undefined): number | undefined {
  const match = /(?:^|,\s*)route;dur=([\d.]+)/.exec(header ?? '');
  return match ? Number(match[1]) : undefined;
}

describe('global route middlewares ( http.routes.middlewares )', function () {
  this.timeout(15000);

  describe('declared by name, by class and with options', () => {
    let app: TestApp;

    before(async () => {
      const entries: GlobalRouteMiddlewareEntry[] = ['GlobalByName', GlobalByClass, { service: 'GlobalWithOptions', options: ['opt'] }, GlobalOuter, { service: GlobalSkippable }];
      app = await httpApp({
        configuration: configWith(entries),
        register: (c) => {
          c.register(GlobalMwController).as(BaseController);
          c.register(GlobalPlainController).as(BaseController);
        },
        resolve: [Intl, Controllers],
      });
      await (await app.resolve(HttpServer)).start();
    });

    after(async () => {
      await app.dispose();
    });

    it('runs every entry on a route of a controller with no @Middleware, options reaching the constructor', async () => {
      const res = await req().get('global-plain/plain');
      expect(res.status).to.eq(200);
      expect(headerOf(res, 'x-mw')).to.eq('global-outer,name,class,options:opt,skippable');
    });

    it('runs the global ones first, then the controller ones, then the route ones, outer before inner', async () => {
      const res = await req().get('global-mw/ordered');
      expect(res.status).to.eq(200);
      expect(headerOf(res, 'x-mw')).to.eq('global-outer,controller-outer,name,class,options:opt,skippable,controller,route');
    });

    it('keeps a middleware whose isEnabled is false off that route only', async () => {
      const res = await req().get('global-mw/skipped');
      expect(res.status).to.eq(200);
      expect(headerOf(res, 'x-mw')).to.eq('global-outer,controller-outer,name,class,options:opt,controller');
      expect(GlobalSkippable.paths.some((p) => p.endsWith('global-mw/skipped'))).to.eq(false);
      expect(GlobalSkippable.paths.some((p) => p.endsWith('global-mw/ordered'))).to.eq(true);
    });

    it('shares one instance per entry across every route, calling onRegister per route', () => {
      expect(GlobalByName.instances.size).to.eq(1);
      for (const path of ['global-mw/ordered', 'global-mw/skipped', 'global-plain/plain', 'global-plain/other']) {
        expect(GlobalByName.paths.some((p) => p.endsWith(path)), path).to.eq(true);
      }
      expect(GlobalWithOptions.created).to.eq(1);
    });
  });

  describe('RouteTiming declared globally', () => {
    let app: TestApp;

    before(async () => {
      app = await httpApp({
        configuration: configWith(['RouteTiming']),
        register: (c) => c.register(GlobalPlainController).as(BaseController),
        resolve: [Intl, Controllers],
      });
      await (await app.resolve(HttpServer)).start();
    });

    after(async () => {
      await app.dispose();
    });

    it('gives every route a route;dur= Server-Timing entry', async () => {
      for (const path of ['global-plain/plain', 'global-plain/other']) {
        const res = await req().get(path);
        expect(res.status, path).to.eq(200);
        expect(routeDuration(headerOf(res, 'server-timing')), path).to.be.a('number');
      }
    });
  });

  describe('a bad entry', () => {
    it('fails the boot with InvalidOption naming the key and the unknown name', async () => {
      let error: unknown;
      try {
        const app = await httpApp({
          configuration: configWith(['NoSuchRouteMiddleware']),
          register: (c) => c.register(GlobalPlainController).as(BaseController),
          resolve: [Intl, Controllers],
        });
        await app.dispose();
      } catch (err) {
        error = err;
      }

      expect(error).to.be.instanceOf(InvalidOption);
      expect((error as Error).message).to.contain('http.routes.middlewares');
      expect((error as Error).message).to.contain('NoSuchRouteMiddleware');
    });

    it('refuses a class that is not a RouteMiddleware', async () => {
      const err = await resolveGlobalRouteMiddlewares(cfgOf([NotAMiddleware]), DI.RootContainer).catch((e: unknown) => e);
      expect(err).to.be.instanceOf(InvalidOption);
      expect((err as Error).message).to.contain('http.routes.middlewares');
      expect((err as Error).message).to.contain('NotAMiddleware');
    });

    it('refuses a { service } entry whose options are not an array, and an entry of another shape', async () => {
      for (const entry of [{ service: GlobalByClass, options: 'x' }, 42, { options: [] }]) {
        const err = await resolveGlobalRouteMiddlewares(cfgOf([entry]), DI.RootContainer).catch((e: unknown) => e);
        expect(err, JSON.stringify(entry)).to.be.instanceOf(InvalidOption);
        expect((err as Error).message).to.contain('http.routes.middlewares');
      }
    });

    it('resolves nothing for no entries', async () => {
      expect(await resolveGlobalRouteMiddlewares(cfgOf([]), DI.RootContainer)).to.deep.eq([]);
    });
  });
});
