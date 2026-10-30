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

import { BaseController, BasePath, Body, Controllers, Get, HttpServer, Ok, Param, ParameterType, PKey, Post, Query, QueryField } from '../src/index.js';

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

@BasePath('/')
class RootRouteController extends BaseController {
  @Get('/')
  public slash() {
    return new Ok({ handler: 'slash' });
  }
}

@BasePath('/lead')
class LeadingSlashRouteController extends BaseController {
  @Get('x')
  public x() {
    return new Ok({ handler: 'x' });
  }
}

type ListQuery = { page?: number; perPage?: number };
type CreateUser = { email: string };

// One handler per row of the manifest's `ParamEntry.wire` table.
@BasePath('wire')
class WireRouteController extends BaseController {
  @Get('dto')
  public dto(@Query() query: ListQuery) {
    return new Ok({ handler: 'dto', value: query ?? null });
  }

  @Get('prims')
  public prims(@Query() page: number, @Query() perPage: number) {
    return new Ok({ handler: 'prims', value: [page ?? null, perPage ?? null] });
  }

  @Get('flat')
  public flat(@QueryField() q: ListQuery) {
    return new Ok({ handler: 'flat', value: q });
  }

  @Post('one')
  public one(@Body() body: CreateUser) {
    return new Ok({ handler: 'one', value: body });
  }

  @Post('two')
  public two(@Body() a: CreateUser, @Body() b: CreateUser) {
    return new Ok({ handler: 'two', value: [a, b] });
  }

  @Post('prim')
  public prim(@Body() email: string) {
    return new Ok({ handler: 'prim', value: email ?? null });
  }

  @Post('keyed')
  public keyed(@Body() dto: CreateUser, @PKey(ParameterType.FromBody) id: number) {
    return new Ok({ handler: 'keyed', value: [dto ?? null, id ?? null] });
  }
}

const CONTROLLERS = [UsersRouteController, NoBaseRouteController, NestedRouteController, RootRouteController, LeadingSlashRouteController, WireRouteController];

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

describe('served route paths and argument binding', function () {
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

  it("registers @BasePath('/') + @Get('/') as // and answers it at / only (the router strips trailing slashes)", async () => {
    expect(mounted(RootRouteController)).to.deep.equal(['GET //']);
    expect(await status('GET', '/')).to.deep.equal([200, 'slash']);
    expect((await status('GET', '//'))[0]).to.equal(404);
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

  const call = async (method: string, path: string, body?: unknown): Promise<[number, unknown]> => {
    const res = await fetch(base + path, { method, headers: { accept: 'application/json', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return [res.status, res.ok ? (JSON.parse(text) as { value: unknown }).value : undefined];
  };

  it('binds an object @Query from JSON under the parameter name, not from flat or bracket keys', async () => {
    expect(await call('GET', `/wire/dto?${new URLSearchParams({ query: JSON.stringify({ page: 2 }) }).toString()}`)).to.deep.equal([200, { page: 2 }]);
    expect(await call('GET', '/wire/dto?page=2')).to.deep.equal([200, null]);
    expect(await call('GET', '/wire/dto?query[page]=2')).to.deep.equal([200, null]);
  });

  it('binds primitive @Query arguments one key each, and @QueryField as the flat query of strings', async () => {
    expect(await call('GET', '/wire/prims?page=1&perPage=2')).to.deep.equal([200, [1, 2]]);
    expect(await call('GET', '/wire/flat?page=1&a[b]=c&rep=1&rep=2')).to.deep.equal([200, { page: '1', 'a[b]': 'c', rep: ['1', '2'] }]);
  });

  it('binds a single object @Body to the whole body, several or a primitive one to fields', async () => {
    expect(await call('POST', '/wire/one', { email: 'a@b' })).to.deep.equal([200, { email: 'a@b' }]);
    expect(await call('POST', '/wire/two', { email: 'a@b' })).to.deep.equal([200, [null, null]]);
    expect(await call('POST', '/wire/two', { a: { email: 'a@b' }, b: { email: 'b@b' } })).to.deep.equal([200, [{ email: 'a@b' }, { email: 'b@b' }]]);
    expect(await call('POST', '/wire/prim', { email: 'x@y' })).to.deep.equal([200, 'x@y']);
    expect((await call('POST', '/wire/prim', 'x@y'))[0]).to.equal(400);
  });

  it('counts @PKey(ParameterType.FromBody) as a body argument: a @Body next to it is a field, not the whole body', async () => {
    expect(await call('POST', '/wire/keyed', { email: 'a@b', id: 1 })).to.deep.equal([200, [null, 1]]);
    expect(await call('POST', '/wire/keyed', { dto: { email: 'a@b' }, id: 1 })).to.deep.equal([200, [{ email: 'a@b' }, 1]]);
  });
});
