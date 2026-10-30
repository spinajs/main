import 'mocha';
import { expect } from 'chai';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { AccessPolicy, PrincipalMiddleware } from '@spinajs/authz-http';
import { analyzePackage } from '@spinajs/compiler';
import { FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { fsService } from '@spinajs/fs';
import { BaseController, BasePolicy, Controllers, HttpServer, ServerMiddleware } from '@spinajs/http';
import { mergeFragments, type Manifest } from '@spinajs/manifest';
import { Intl } from '@spinajs/intl';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import shipped from '../../http/lib/config/http.js';
import { HealthController } from '../../compiler/test/fixtures/app-basic/src/controllers/HealthController.js';
import { UsersController } from '../../compiler/test/fixtures/app-basic/src/controllers/users.js';
import { createClient, ProblemError } from '../src/runtime/index.js';
import type { ClientDefinition } from '../src/runtime/index.js';
import { generateClient } from '../src/index.js';
import type { AppClient } from './__snapshots__/app-basic.client.js';
import { MixedController, WireController, received as wireReceived } from './fixtures/wire-app/src/controllers.js';
import type { CreateDto, Filter, Meta, Profile } from './fixtures/wire-app/src/controllers.js';
import { appBasicManifest } from './support/fixture.js';

// The fixture guards two routes with @Access; authorization is not what this suite checks. Importing the fixture
// also registers authz-http's PrincipalMiddleware, which stops the server when no authz domain boots.
class AllowAccess extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {}
}

interface WireClient {
  values(page: number, verbose: boolean, since: Date): Promise<void>;
  wholeQuery(filter: Filter): Promise<void>;
  headers(tenant: string, meta: Meta): Promise<void>;
  cookie(session: string): Promise<void>;
  fields(user: CreateDto, note: string): Promise<void>;
  primitive(email: string): Promise<void>;
  photos(photos: (Blob | File)[], title: string, meta: Meta, tags: string[]): Promise<void>;
  profile(profile: Profile): Promise<void>;
  optional(id?: number): Promise<void>;
  tree(path: string[]): Promise<void>;
}

type Action = (this: BaseController, ...args: unknown[]) => unknown;

/** The route arguments each app-basic action was called with, keyed `Controller.handler`. */
const received: Record<string, unknown[]> = {};

/** Records the arguments of the fixture's own actions, which keep their routes, decorators and responses. */
function recordArguments(controller: typeof BaseController, manifest: Manifest): () => void {
  const entry = manifest.controllers.find((c) => c.className === controller.name);
  if (!entry) throw new Error(`${controller.name} is not in the app-basic manifest`);
  const actions = controller.prototype as unknown as Record<string, Action>;
  const originals = entry.routes.map(({ handler, params }) => {
    const action = actions[handler];
    actions[handler] = function (this: BaseController, ...args: unknown[]) {
      received[`${controller.name}.${handler}`] = args.slice(0, params.length);
      return action.apply(this, args);
    };
    return () => (actions[handler] = action);
  });
  return () => originals.forEach((restore) => restore());
}

const wireApp = fileURLToPath(new URL('./fixtures/wire-app', import.meta.url));

async function wireManifest(): Promise<Manifest> {
  const fragment = await analyzePackage({ tsconfig: `${wireApp}/tsconfig.json`, packageRoot: wireApp });
  return mergeFragments(fragment, [], { app: { name: 'wire-app', version: '0.1.0', root: '.', outDir: 'lib' }, packages: [], generatedAt: '' });
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
      http: { port: 0, middlewares: shipped.http.middlewares, AcceptHeaders: 1 | 2 },
    };
  }
}

function extractDefinition(generated: string): ClientDefinition {
  const match = /const definition: ClientDefinition = (\{[\s\S]*?\n\});/.exec(generated);
  if (!match) throw new Error('definition not found in generated source');
  return runInNewContext(`(${match[1]})`) as ClientDefinition;
}

describe('generated client against real controllers on a booted server', function () {
  this.timeout(60000);

  let app: TestApp;
  let baseUrl: string;
  let client: AppClient;
  let wire: WireClient;
  let wireWithMixed: Manifest;
  const restores: (() => void)[] = [];

  before(async () => {
    const manifest = await appBasicManifest();
    wireWithMixed = await wireManifest();
    const wireOnly = { ...wireWithMixed, controllers: wireWithMixed.controllers.filter((c) => c.className !== MixedController.name) };
    restores.push(recordArguments(HealthController, manifest), recordArguments(UsersController, manifest));
    app = await createTestApp({
      configuration: E2eConfiguration,
      register: (c) => {
        c.unregister(ServerMiddleware, PrincipalMiddleware);
        for (const controller of [HealthController, UsersController, WireController, MixedController]) c.register(controller).as(BaseController);
        c.register(AllowAccess).as(AccessPolicy);
      },
      resolve: [fsService, Intl, Controllers],
      bootTimeout: 50000,
    });
    const server = await app.resolve(HttpServer);
    await server.start();
    const { port } = DI.get(HttpServer)!.Server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    client = createClient<AppClient>(extractDefinition(await generateClient({ manifest })), { baseUrl });
    wire = createClient<{ wire: WireClient }>(extractDefinition(await generateClient({ manifest: wireOnly })), { baseUrl }).wire;
  });

  after(async () => {
    restores.forEach((restore) => restore());
    await app.dispose();
  });

  describe('app-basic', () => {
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
      expect((error as ProblemError).problem).to.not.have.property('stack');
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

    it('users.avatar refuses a dot-segment id instead of posting to another route', async () => {
      delete received['UsersController.avatar'];
      const error = await client.users.avatar('..' as unknown as number, new File(['png'], 'me.png')).catch((e: unknown) => e);
      expect(error).to.be.instanceOf(TypeError);
      expect(received).to.not.have.property('UsersController.avatar');
    });
  });

  describe('every other wire shape', () => {
    it('value query arguments, a Date as its ISO string', async () => {
      await wire.values(2, true, new Date('2026-01-02T03:04:05.000Z'));
      expect(wireReceived.values).to.deep.equal([2, true, '2026-01-02T03:04:05.000Z']);
    });

    it('a whole query argument as flat keys, which the handler gets as strings', async () => {
      await wire.wholeQuery({ page: 3, q: 'ada' });
      expect(wireReceived.wholeQuery).to.deep.equal([{ page: '3', q: 'ada' }]);
    });

    it('a value header and a json header', async () => {
      await wire.headers('acme', { level: 1, tags: ['a'] });
      expect(wireReceived.headers).to.deep.equal(['acme', { level: 1, tags: ['a'] }]);
    });

    it('a cookie argument', async () => {
      await wire.cookie('s 1;x');
      expect(wireReceived.cookie).to.deep.equal(['s 1;x']);
    });

    it('field body arguments merged into one object', async () => {
      await wire.fields({ email: 'a@b' }, 'hi');
      expect(wireReceived.fields).to.deep.equal([{ email: 'a@b' }, 'hi']);
    });

    it('a primitive body argument wrapped under its name', async () => {
      await wire.primitive('x@y');
      expect(wireReceived.primitive).to.deep.equal(['x@y']);
    });

    it('multiple files and form fields: value, json and repeated', async () => {
      await wire.photos([new File(['a'], 'a.png'), new File(['bb'], 'b.png')], 'Trip', { level: 2, tags: ['x'] }, ['p', 'q']);
      const [photos, title, meta, tags] = wireReceived.photos as [{ Name: string; Size: number }[], string, Meta, string[]];
      expect(photos.map((p) => [p.Name, p.Size])).to.deep.equal([
        ['a.png', 1],
        ['b.png', 2],
      ]);
      expect([title, meta, tags]).to.deep.equal(['Trip', { level: 2, tags: ['x'] }, ['p', 'q']]);
    });

    it('a whole @Form() with nested objects and arrays as bracketed keys', async () => {
      await wire.profile({ name: 'Ada', address: { city: 'London', zip: 'N1' }, langs: ['en', 'pl'] });
      expect(wireReceived.profile).to.deep.equal([{ name: 'Ada', address: { city: 'London', zip: 'N1' }, langs: ['en', 'pl'] }]);
    });

    it('an Express 5 optional segment, left out and filled', async () => {
      await wire.optional();
      expect(wireReceived.optional).to.deep.equal([undefined]);
      await wire.optional(5);
      expect(wireReceived.optional).to.deep.equal([5]);
    });

    it('an Express 5 wildcard as encoded segments', async () => {
      await wire.tree(['docs', 'a b', 'c.txt']);
      expect(wireReceived.tree).to.deep.equal([['docs', 'a b', 'c.txt']]);
    });

    it('refuses to generate a @Body next to a file, which the server binds as null', async () => {
      const error = await generateClient({ manifest: wireWithMixed }).catch((e: unknown) => e);
      expect((error as Error).message).to.match(/MixedController\.upload \(POST \/mixed\/upload\) sends body argument\(s\) 'meta' next to multipart argument\(s\) 'file'/);
      const form = new FormData();
      form.append('file', new File(['x'], 'x.txt'));
      form.append('meta', JSON.stringify({ level: 1, tags: [] }));
      expect((await fetch(`${baseUrl}/mixed/upload`, { method: 'POST', body: form })).status).to.equal(204);
      expect(wireReceived.mixedUpload[1]).to.equal(null);
    });
  });
});
