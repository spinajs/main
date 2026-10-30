import 'mocha';
import { expect } from 'chai';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import express from 'express';
import { FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { ResourceNotFound } from '@spinajs/exceptions';
import { fsService } from '@spinajs/fs';
import { BaseController, BasePath, Body, Controllers, Get, HttpServer, Ok, Param, Post, QueryField } from '@spinajs/http';
import { Intl } from '@spinajs/intl';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { createClient, ProblemError } from '../src/runtime/index.js';
import type { ClientDefinition } from '../src/runtime/index.js';
import { generateClient } from '../src/index.js';
import { appBasicManifest } from './support/fixture.js';

type UserDto = { id: number; email: string; name?: string };
type CreateUserDto = { email: string; name?: string };
type ListQuery = { page?: number; perPage?: number };

const USERS: UserDto[] = [{ id: 1, email: 'ada@example.com', name: 'Ada' }];

// Same routes as the app-basic fixture, minus the authz policies the fixture needs a user for.
// An empty route path serves `/<base>/<handler>`, so the root routes say `/` explicitly.
@BasePath('users')
class UsersController extends BaseController {
  @Get('/')
  public list(@QueryField() query: ListQuery): Ok {
    const page = Number(query.page ?? 1);
    const perPage = Number(query.perPage ?? 10);
    return new Ok(USERS.slice((page - 1) * perPage, page * perPage));
  }

  @Get(':id')
  public get(@Param() id: number): Ok {
    const user = USERS.find((u) => u.id === Number(id));
    if (!user) throw new ResourceNotFound(`user ${id}`);
    return new Ok(user);
  }

  @Post('/')
  public create(@Body() body: CreateUserDto): Ok {
    const user = { id: USERS.length + 1, ...body };
    USERS.push(user);
    return new Ok(user);
  }
}

class E2eConfiguration extends FrameworkConfiguration {
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
      http: { port: 0, middlewares: [express.json()], AcceptHeaders: 1 | 2 },
    };
  }
}

function extractDefinition(generated: string): ClientDefinition {
  const match = /const definition: ClientDefinition = (\{[\s\S]*?\n\});/.exec(generated);
  if (!match) throw new Error('definition not found in generated source');
  return runInNewContext(`(${match[1]})`) as ClientDefinition;
}

interface UsersApi {
  users: {
    list(query?: ListQuery): Promise<UserDto[]>;
    get(params: { id: number }): Promise<UserDto>;
    create(body: CreateUserDto): Promise<UserDto>;
  };
}

describe('generated definition against a booted server', function () {
  this.timeout(60000);

  let app: TestApp;
  let client: UsersApi;

  before(async () => {
    const definition = extractDefinition(await generateClient({ manifest: await appBasicManifest() }));
    app = await createTestApp({
      configuration: E2eConfiguration,
      register: (c) => c.register(UsersController).as(BaseController),
      resolve: [fsService, Intl, Controllers],
      bootTimeout: 50000,
    });
    const server = await app.resolve(HttpServer);
    await server.start();
    const { port } = DI.get(HttpServer)!.Server.address() as AddressInfo;
    client = createClient<UsersApi>(definition, { baseUrl: `http://127.0.0.1:${port}` });
  });

  after(() => app.dispose());

  it('passes path params positionally', async () => {
    expect(await client.users.get({ id: 1 })).to.deep.include({ id: 1, email: 'ada@example.com' });
  });

  it('serialises the query argument', async () => {
    expect(await client.users.list({ page: 1, perPage: 5 })).to.have.length(1);
    expect(await client.users.list({ page: 2, perPage: 5 })).to.have.length(0);
  });

  it('sends the body argument as json', async () => {
    const created = await client.users.create({ email: 'grace@example.com' });
    expect(created).to.deep.include({ email: 'grace@example.com' });
  });

  it('rejects with ProblemError 404 for a missing user', async () => {
    const error = await client.users.get({ id: 404 }).catch((e: unknown) => e);
    expect(error).to.be.instanceOf(ProblemError);
    expect((error as ProblemError).status).to.equal(404);
  });
});
