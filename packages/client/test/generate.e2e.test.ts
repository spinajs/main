import 'mocha';
import { expect } from 'chai';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import express from 'express';
import { AccessPolicy, PrincipalMiddleware } from '@spinajs/authz-http';
import { FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { fsService } from '@spinajs/fs';
import { BaseController, BasePolicy, Controllers, HttpServer, Ok, Response as HttpResponse, ServerMiddleware } from '@spinajs/http';
import type { Manifest } from '@spinajs/manifest';
import { Intl } from '@spinajs/intl';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { HealthController } from '../../compiler/test/fixtures/app-basic/src/controllers/HealthController.js';
import { UsersController } from '../../compiler/test/fixtures/app-basic/src/controllers/users.js';
import { createClient, ProblemError } from '../src/runtime/index.js';
import type { ClientDefinition } from '../src/runtime/index.js';
import { generateClient } from '../src/index.js';
import type { AppClient } from './__snapshots__/app-basic.client.js';
import { appBasicManifest } from './support/fixture.js';

// The fixture guards two routes with @Access; authorization is not what this suite checks. Importing the fixture
// also registers authz-http's PrincipalMiddleware, which stops the server when no authz domain boots.
class AllowAccess extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {}
}

type Action = (this: BaseController, ...args: unknown[]) => unknown;

/** The route arguments each fixture action was called with, keyed `Controller.handler`. */
const received: Record<string, unknown[]> = {};

// The fixture actions return plain values, which is all the manifest needs, but http answers only a Response
// (a plain value is a 500, undefined a 404). The subclass keeps the fixture's routes and argument decorators.
function served(controller: typeof BaseController, manifest: Manifest): typeof BaseController {
  const Served = class extends controller {};
  // DI and the route log key controllers by class name.
  Object.defineProperty(Served, 'name', { value: controller.name });
  const entry = manifest.controllers.find((c) => c.className === controller.name);
  if (!entry) throw new Error(`${controller.name} is not in the app-basic manifest`);
  for (const { handler, params } of entry.routes) {
    const action = (controller.prototype as unknown as Record<string, Action>)[handler];
    Object.defineProperty(Served.prototype, handler, {
      value: async function (this: BaseController, ...args: unknown[]) {
        received[`${controller.name}.${handler}`] = args.slice(0, params.length);
        const result = await action.apply(this, args);
        return result instanceof HttpResponse ? result : new Ok(result);
      },
    });
  }
  return Served;
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

describe('generated client against the app-basic controllers on a booted server', function () {
  this.timeout(60000);

  let app: TestApp;
  let client: AppClient;

  before(async () => {
    const manifest = await appBasicManifest();
    const definition = extractDefinition(await generateClient({ manifest }));
    app = await createTestApp({
      configuration: E2eConfiguration,
      register: (c) => {
        c.unregister(ServerMiddleware, PrincipalMiddleware);
        c.register(served(HealthController, manifest)).as(BaseController);
        c.register(served(UsersController, manifest)).as(BaseController);
        c.register(AllowAccess).as(AccessPolicy);
      },
      resolve: [fsService, Intl, Controllers],
      bootTimeout: 50000,
    });
    const server = await app.resolve(HttpServer);
    await server.start();
    const { port } = DI.get(HttpServer)!.Server.address() as AddressInfo;
    client = createClient<AppClient>(definition, { baseUrl: `http://127.0.0.1:${port}` });
  });

  after(() => app.dispose());

  it('health.get calls the handler-named path', async () => {
    expect(await client.health.get()).to.deep.equal({ ok: true });
  });

  it('users.list sends the query DTO as JSON under its parameter name', async () => {
    expect(await client.users.list({ page: 1, perPage: 5 })).to.deep.equal([{ id: 1, email: 'ada@example.com', name: 'Ada' }]);
    expect(received['UsersController.list']).to.deep.equal([{ page: 1, perPage: 5 }]);
    expect(await client.users.list({ page: 2, perPage: 5 })).to.deep.equal([]);
    expect(await client.users.list({})).to.have.length(1);
  });

  it('users.get sends the id as a path segment', async () => {
    expect(await client.users.get(1)).to.deep.equal({ id: 1, email: 'ada@example.com', name: 'Ada' });
    expect(received['UsersController.get']).to.deep.equal([1]);
  });

  it('users.get rejects with ProblemError 404 for a missing user', async () => {
    const error = await client.users.get(404).catch((e: unknown) => e);
    expect(error).to.be.instanceOf(ProblemError);
    expect((error as ProblemError).status).to.equal(404);
    expect(received['UsersController.get']).to.deep.equal([404]);
  });

  it('users.create sends the DTO as the whole body', async () => {
    expect(await client.users.create({ email: 'grace@example.com', name: 'Grace' })).to.deep.equal({ id: 2, email: 'grace@example.com', name: 'Grace' });
    expect(received['UsersController.create']).to.deep.equal([{ email: 'grace@example.com', name: 'Grace' }]);
    expect(await client.users.create({ email: 'nope' })).to.deep.equal({ kind: 'validation', errors: ['email'] });
  });

  it('users.avatar sends the file as a multipart part', async () => {
    expect(await client.users.avatar(1, new File(['png'], 'me.png', { type: 'image/png' }))).to.equal(undefined);
    const [id, file] = received['UsersController.avatar'] as [number, { Name: string; Size: number }];
    expect(id).to.equal(1);
    expect(file).to.deep.include({ Name: 'me.png', Size: 3 });
  });
});
