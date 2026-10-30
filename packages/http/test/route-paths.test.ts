import 'mocha';
import { expect } from 'chai';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import express from 'express';
import { FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { fsService } from '@spinajs/fs';
import { Intl } from '@spinajs/intl';
import { createTestApp, type TestApp } from '@spinajs/testing';

import { BaseController, BasePath, Controllers, Get, HttpServer, Ok, Param, Post } from '../src/index.js';

@BasePath('users')
class UsersRouteController extends BaseController {
  @Get()
  public list() {
    return new Ok({ handler: 'list' });
  }

  @Get('')
  public emptyString() {
    return new Ok({ handler: 'emptyString' });
  }

  @Get('/')
  public root() {
    return new Ok({ handler: 'root' });
  }

  @Get('/slash')
  public leadingSlash() {
    return new Ok({ handler: 'leadingSlash' });
  }

  @Post()
  public create() {
    return new Ok({ handler: 'create' });
  }

  @Get(':id')
  public get(@Param() id: number) {
    return new Ok({ handler: 'get', id });
  }
}

class NoBaseRouteController extends BaseController {
  @Get('ping')
  public ping() {
    return new Ok({ handler: 'ping' });
  }

  @Get()
  public pong() {
    return new Ok({ handler: 'pong' });
  }
}

@BasePath('api/v2/things')
class NestedRouteController extends BaseController {
  @Get()
  public all() {
    return new Ok({ handler: 'all' });
  }

  @Get('/')
  public index() {
    return new Ok({ handler: 'index' });
  }
}

@BasePath('/lead')
class LeadingSlashRouteController extends BaseController {
  @Get('x')
  public x() {
    return new Ok({ handler: 'x' });
  }
}

const CONTROLLERS = [UsersRouteController, NoBaseRouteController, NestedRouteController, LeadingSlashRouteController];

class RoutePathConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    const provider = (name: string) => ({ service: 'fsNative', name, basePath: tmpdir() });
    this.Config = {
      system: { dirs: { controllers: [] } },
      fs: {
        defaultProvider: 'fs-temp',
        providers: [provider('fs-temp'), provider('__file_upload_default_provider__'), provider('__fs_http_templates__'), provider('__fs_controller_cache__'), provider('__fs_http_response_templates__')],
      },
      intl: { locales: ['en'], defaultLocale: 'en' },
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '${message}' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
      http: { port: 0, middlewares: [express.json(), express.urlencoded({ extended: true })], AcceptHeaders: 1 | 2 },
    };
  }
}

describe('served route paths', function () {
  this.timeout(60000);

  let app: TestApp;
  let base: string;

  before(async () => {
    app = await createTestApp({
      configuration: RoutePathConfiguration,
      register: (c) => {
        for (const t of CONTROLLERS) c.register(t).as(BaseController);
      },
      resolve: [fsService, Intl, Controllers],
      bootTimeout: 50000,
    });
    const server = await app.resolve(HttpServer);
    await server.start();
    base = `http://127.0.0.1:${(server.Server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await DI.get(HttpServer)?.stop();
    await app?.dispose();
  });

  const mounted = (type: new () => BaseController): string[] => {
    const stack = DI.get<BaseController>(type)!.Router.stack as { route?: { path: string; methods: Record<string, boolean> } }[];
    return stack.filter((l) => l.route).map((l) => `${Object.keys(l.route!.methods).join(',').toUpperCase()} ${l.route!.path}`);
  };

  const status = async (method: string, path: string): Promise<[number, unknown]> => {
    const res = await fetch(base + path, { method, headers: { accept: 'application/json' } });
    const text = await res.text();
    return [res.status, res.ok ? (JSON.parse(text) as { handler: string }).handler : undefined];
  };

  it('mounts a bare or empty route path under the handler name, and keeps a leading slash as //', () => {
    expect(mounted(UsersRouteController)).to.deep.equal(['GET /users/list', 'GET /users/emptyString', 'GET /users', 'GET /users//slash', 'POST /users/create', 'GET /users/:id']);
    expect(mounted(NestedRouteController)).to.deep.equal(['GET /api/v2/things/all', 'GET /api/v2/things']);
  });

  it('mounts a controller without @BasePath under its lower-cased class name', () => {
    expect(mounted(NoBaseRouteController)).to.deep.equal(['GET /nobaseroutecontroller/ping', 'GET /nobaseroutecontroller/pong']);
  });

  it('keeps the double slash of a leading-slash @BasePath', () => {
    expect(mounted(LeadingSlashRouteController)).to.deep.equal(['GET //lead/x']);
  });

  it('answers on the mounted paths only', async () => {
    expect(await status('GET', '/users/list')).to.deep.equal([200, 'list']);
    expect(await status('GET', '/users')).to.deep.equal([200, 'root']);
    expect(await status('POST', '/users/create')).to.deep.equal([200, 'create']);
    expect((await status('POST', '/users'))[0]).to.equal(404);
    expect(await status('GET', '/nobaseroutecontroller/pong')).to.deep.equal([200, 'pong']);
    expect(await status('GET', '/api/v2/things/all')).to.deep.equal([200, 'all']);
    expect((await status('GET', '/lead/x'))[0]).to.equal(404);
  });
});
