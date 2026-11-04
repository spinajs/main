import 'mocha';
import { expect } from 'chai';
import { createElement, type ComponentType, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyzePackage } from '@spinajs/compiler';
import { mergeFragments, type Manifest } from '@spinajs/manifest';
import type { TestApp } from '@spinajs/testing';
import { HealthController } from '../../compiler/test/fixtures/app-basic/src/controllers/HealthController.js';
import { UsersController } from '../../compiler/test/fixtures/app-basic/src/controllers/users.js';
import { generateClientFiles } from '../src/index.js';
import { WireController } from './fixtures/wire-app/src/controllers.js';
import { appBasicManifest } from './support/fixture.js';
import { startApp } from './support/harness.js';
import { installDom, libraryUrls, quiet, waitFor, writeModules, type Dom, type ModuleDir } from './support/modules.js';

interface QueryResult {
  data?: unknown;
  error?: unknown;
  isLoading?: boolean;
}

interface MutationResult {
  error?: unknown;
  mutateAsync?: (vars: unknown) => Promise<unknown>;
  trigger?: (vars: unknown) => Promise<unknown>;
}

type QueryHook = (vars?: unknown, options?: object) => QueryResult;
type MutationHook = (options?: object) => MutationResult;

interface HookModule {
  useUsersGet: QueryHook;
  useUsersList: QueryHook;
  useHealthGet: QueryHook;
  useUsersCreate: MutationHook;
  useUsersAvatar: MutationHook;
}

interface WireHookModule {
  useWireOptional: QueryHook;
}

type Wrap = (children: ReactNode) => ReactElement;

interface Library {
  name: string;
  hooks: HookModule;
  wire: WireHookModule;
  /** The library's provider around a fresh cache, with no retries and no focus refetch. */
  provider(): Wrap;
  /** The arguments of a query hook that fetches `vars` only once `enabled` is true. */
  conditional(vars: object, enabled: boolean): [unknown, object?];
}

type Problem = Error & { status: number; problem: { title?: string; errors?: unknown } };

type ProblemErrorClass = new (...args: never[]) => Problem;

const PACKAGES = ['react', '@tanstack/react-query', 'swr', 'swr/mutation', '@spinajs/client/runtime', '@spinajs/http-socket-common'];

/**
 * Both libraries re-render a component only for the result fields its render read, so each hook's fields are read
 * during the render that called it, as a component would.
 */
function readInRender<T extends object>(module: T): T {
  const read = (hook: (...args: unknown[]) => QueryResult & MutationResult) => (...args: unknown[]) => {
    const { data, error, isLoading, mutateAsync, trigger } = hook(...args);
    return { data, error, isLoading, mutateAsync, trigger };
  };
  return Object.fromEntries(Object.entries(module).map(([name, value]) => [name, name.startsWith('use') ? read(value as never) : value])) as T;
}

const run = (mutation: MutationResult) => (vars: unknown) => (mutation.mutateAsync ?? mutation.trigger)!(vars);

const appBasicRoot = fileURLToPath(new URL('../../compiler/test/fixtures/app-basic', import.meta.url));

const wireApp = fileURLToPath(new URL('./fixtures/wire-app', import.meta.url));

async function wireOnlyManifest(): Promise<Manifest> {
  const fragment = await analyzePackage({ tsconfig: `${wireApp}/tsconfig.json`, packageRoot: wireApp });
  const manifest = mergeFragments(fragment, [], { app: { name: 'wire-app', version: '0.1.0', root: '.', outDir: 'lib' }, packages: [], generatedAt: '' });
  return { ...manifest, controllers: manifest.controllers.filter((c) => c.className === WireController.name) };
}

/** `sharedReact` replaces the generated context module, so hooks of a second manifest read the first one's provider. */
async function loadGenerated(manifest: Manifest, sharedReact?: string): Promise<ModuleDir> {
  const files = Object.fromEntries((await generateClientFiles({ manifest, hooks: ['react-query', 'swr'] })).map((f) => [f.path, f.contents]));
  if (sharedReact) {
    delete files['client.react.ts'];
    files['client.react.js'] = `export * from '${sharedReact}';`;
  }
  return writeModules(files, libraryUrls(PACKAGES));
}

describe('generated hooks against a booted app', function () {
  this.timeout(60000);

  let dom: Dom;
  let appBasic: ModuleDir;
  let wire: ModuleDir;
  let ProblemError: ProblemErrorClass;
  let clientFor: (baseUrl: string) => object;
  let AppClientProvider: ComponentType<{ client: unknown; children?: ReactNode }>;
  let client: object;
  const requests: string[] = [];
  /** The requests whose reply has arrived. */
  const answered: string[] = [];
  const libraries: Library[] = [];
  const roots: Root[] = [];

  before(async () => {
    appBasic = await loadGenerated(await appBasicManifest());
    wire = await loadGenerated(await wireOnlyManifest(), pathToFileURL(appBasic.path('client.react.js')).href);
    // After the generator, whose schema tooling takes a browser path under a `window`, and before SWR loads, which
    // picks its browser path then.
    dom = installDom();

    const logged: typeof fetch = (input, init) => {
      const request = `${init?.method ?? 'GET'} ${new URL(input instanceof Request ? input.url : input).pathname}`;
      requests.push(request);
      return fetch(input, init).then((response) => (answered.push(request), response));
    };
    type CreateClient = { createAppClient: (options: { baseUrl: string; fetch: typeof fetch }) => unknown };
    const [{ createAppClient }, { createAppClient: createWireClient }, react, runtime] = await Promise.all([
      appBasic.import<CreateClient>('client.js'),
      wire.import<CreateClient>('client.js'),
      appBasic.import<{ AppClientProvider: ComponentType<{ client: unknown; children?: ReactNode }> }>('client.react.js'),
      import(import.meta.resolve('@spinajs/client/runtime')) as Promise<{ ProblemError: ProblemErrorClass }>,
    ]);
    ProblemError = runtime.ProblemError;
    AppClientProvider = react.AppClientProvider;
    clientFor = (baseUrl) => Object.assign(createAppClient({ baseUrl, fetch: logged }) as object, createWireClient({ baseUrl, fetch: logged }) as object);

    const rq = (await import(import.meta.resolve('@tanstack/react-query'))) as {
      QueryClient: new (config: object) => unknown;
      QueryClientProvider: ComponentType<{ client: unknown; children?: ReactNode }>;
    };
    const swr = (await import(import.meta.resolve('swr'))) as { SWRConfig: ComponentType<{ value: object; children?: ReactNode }> };
    libraries.push(
      {
        name: 'React Query',
        hooks: readInRender(await appBasic.import<HookModule>('client.react-query.js')),
        wire: readInRender(await wire.import<WireHookModule>('client.react-query.js')),
        provider: () => {
          const queryClient = new rq.QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
          return (children) => createElement(rq.QueryClientProvider, { client: queryClient }, children);
        },
        conditional: (vars, enabled) => [vars, { enabled }],
      },
      {
        name: 'SWR',
        hooks: readInRender(await appBasic.import<HookModule>('client.swr.js')),
        wire: readInRender(await wire.import<WireHookModule>('client.swr.js')),
        provider: () => {
          const value = { provider: () => new Map(), dedupingInterval: 0, revalidateOnFocus: false, shouldRetryOnError: false };
          return (children) => createElement(swr.SWRConfig, { value }, children);
        },
        conditional: (vars, enabled) => [enabled ? vars : null],
      },
    );
  });

  after(async () => {
    appBasic?.remove();
    wire?.remove();
    dom?.restore();
  });

  const reset = () => {
    requests.length = 0;
    answered.length = 0;
  };

  beforeEach(reset);

  afterEach(() => {
    for (const root of roots.splice(0)) root.unmount();
  });

  /** Renders `probe` inside the client provider and `providers`; the returned function renders it again. */
  function mount(probe: () => void, providers: Wrap[]): () => void {
    const root = createRoot(dom.document.body.appendChild(dom.document.createElement('div')));
    roots.push(root);
    const Probe = () => {
      probe();
      return null;
    };
    const render = () => root.render(createElement(AppClientProvider, { client }, providers.reduceRight<ReactNode>((children, wrap) => wrap(children), createElement(Probe))));
    render();
    return render;
  }

  const count = (request: string) => requests.filter((r) => r === request).length;

  describe('on the app-basic and wire-app controllers', () => {
    let app: TestApp | undefined;

    before(async () => {
      const started = await startApp([HealthController, UsersController, WireController]);
      app = started.app;
      client = clientFor(started.baseUrl);
    });

    after(() => app?.dispose());

    for (const name of ['React Query', 'SWR']) {
      describe(name, () => {
        let library: Library;
        before(() => (library = libraries.find((l) => l.name === name)!));

        it('loads a query from the server', async () => {
          let user: QueryResult = {};
          mount(() => (user = library.hooks.useUsersGet({ id: 1 })), [library.provider()]);
          await waitFor(() => user.data !== undefined, 'the user');
          expect(user.data).to.deep.equal({ id: 1, email: 'ada@example.com', name: 'Ada' });
          expect(requests).to.deep.equal(['GET /users/1']);
        });

        it('refetches every query of the controller once after a mutation, and no query of another controller', async () => {
          const seen: Record<string, QueryResult> = {};
          let create: MutationResult = {};
          mount(() => {
            seen.list = library.hooks.useUsersList({ query: {} });
            seen.user = library.hooks.useUsersGet({ id: 1 });
            seen.health = library.hooks.useHealthGet();
            create = library.hooks.useUsersCreate();
          }, [library.provider()]);
          await waitFor(() => Object.keys(seen).length === 3 && Object.values(seen).every((q) => q.data !== undefined), 'the first fetches');
          const before = (seen.list.data as unknown[]).length;
          reset();

          const email = `${name.replace(' ', '-').toLowerCase()}@example.com`;
          const created = (await run(create)({ body: { email } })) as { id: number };
          expect(created).to.include({ email });
          // The mutation settles only after the refetch, so every reply has already arrived.
          expect([...answered].sort()).to.deep.equal(['GET /users/1', 'GET /users/list', 'POST /users/create']);
          await waitFor(() => (seen.list.data as unknown[]).length === before + 1, 'the refetched list');
          expect(seen.list.data).to.deep.include({ id: created.id, email });
          await quiet(() => requests);
          expect([count('GET /users/list'), count('GET /users/1'), count('GET /health/get')]).to.deep.equal([1, 1, 0]);
        });

        it('refetches nothing with invalidate: false', async () => {
          let list: QueryResult = {};
          let create: MutationResult = {};
          mount(() => {
            list = library.hooks.useUsersList({ query: {} });
            create = library.hooks.useUsersCreate({ invalidate: false });
          }, [library.provider()]);
          await waitFor(() => list.data !== undefined, 'the list');
          const before = list.data;
          reset();
          await run(create)({ body: { email: `quiet-${name.replace(' ', '-').toLowerCase()}@example.com` } });
          await quiet(() => requests);
          expect(requests).to.deep.equal(['POST /users/create']);
          expect(list.data).to.equal(before);
        });

        it('sends no request while the query is disabled, and fetches once it is enabled', async () => {
          let enabled = false;
          let user: QueryResult = {};
          const render = mount(() => (user = library.hooks.useUsersGet(...library.conditional({ id: 1 }, enabled))), [library.provider()]);
          await quiet(() => requests);
          expect(requests).to.deep.equal([]);
          expect([user.data, user.error ?? null]).to.deep.equal([undefined, null]);
          enabled = true;
          render();
          await waitFor(() => user.data !== undefined, 'the user');
          expect(requests).to.deep.equal(['GET /users/1']);
        });

        it('surfaces a 404 as a ProblemError on error', async () => {
          let user: QueryResult = {};
          mount(() => (user = library.hooks.useUsersGet({ id: 404 })), [library.provider()]);
          await waitFor(() => user.error != null, 'the error');
          expect(user.error).to.be.instanceOf(ProblemError);
          expect((user.error as Problem).status).to.equal(404);
          expect(user.data).to.equal(undefined);
          expect(requests).to.deep.equal(['GET /users/404']);
        });

        it('surfaces a 400 from the server validation as a ProblemError on the query error', async () => {
          let user: QueryResult = {};
          mount(() => (user = library.hooks.useUsersGet({ id: 'abc' })), [library.provider()]);
          await waitFor(() => user.error != null, 'the error');
          expect(user.error).to.be.instanceOf(ProblemError);
          expect((user.error as Problem).status).to.equal(400);
          expect((user.error as Problem).problem.title).to.equal('Validation Failed');
          expect(requests).to.deep.equal(['GET /users/abc']);
        });

        it('rejects a mutation with a 400 as a ProblemError, sets its error, and refetches nothing', async () => {
          let user: QueryResult = {};
          let avatar: MutationResult = {};
          mount(() => {
            user = library.hooks.useUsersGet({ id: 1 });
            avatar = library.hooks.useUsersAvatar();
          }, [library.provider()]);
          await waitFor(() => user.data !== undefined, 'the user');
          reset();
          const rejected = await run(avatar)({ id: 'abc', file: new File(['png'], 'me.png') }).catch((e: unknown) => e);
          expect(rejected).to.be.instanceOf(ProblemError);
          expect((rejected as Problem).status).to.equal(400);
          await waitFor(() => avatar.error != null, 'the mutation error');
          expect(avatar.error).to.equal(rejected);
          await quiet(() => requests);
          expect(requests).to.deep.equal(['POST /users/abc/avatar']);
        });

        it('resolves a query whose reply is a 204 to null, without an error', async () => {
          let optional: QueryResult = {};
          mount(() => (optional = library.wire.useWireOptional()), [library.provider()]);
          await waitFor(() => requests.length > 0 && optional.isLoading === false, 'the reply');
          expect(requests).to.deep.equal(['GET /wire/optional']);
          expect(optional.error ?? null).to.equal(null);
          expect(optional.data).to.equal(null);
        });

        it('resolves a mutation whose reply is a 204, and refetches its controller', async () => {
          let user: QueryResult = {};
          let avatar: MutationResult = {};
          mount(() => {
            user = library.hooks.useUsersGet({ id: 1 });
            avatar = library.hooks.useUsersAvatar();
          }, [library.provider()]);
          await waitFor(() => user.data !== undefined, 'the user');
          reset();
          expect(await run(avatar)({ id: 1, file: new File(['png'], 'me.png', { type: 'image/png' }) })).to.equal(undefined);
          expect([...requests].sort()).to.deep.equal(['GET /users/1', 'POST /users/1/avatar']);
        });
      });
    }

    describe('both libraries', () => {
      it('runs both libraries in one tree, on one client provider, each refetching only its own cache', async () => {
        const [reactQuery, swr] = libraries;
        const seen: Record<string, QueryResult> = {};
        let create: MutationResult = {};
        mount(() => {
          seen.rq = reactQuery.hooks.useUsersGet({ id: 1 });
          seen.swr = swr.hooks.useUsersGet({ id: 1 });
          create = reactQuery.hooks.useUsersCreate();
        }, [reactQuery.provider(), swr.provider()]);
        await waitFor(() => seen.rq?.data !== undefined && seen.swr?.data !== undefined, 'both users');
        expect(seen.rq.data).to.deep.equal(seen.swr.data);
        expect(requests).to.deep.equal(['GET /users/1', 'GET /users/1']);
        reset();
        await run(create)({ body: { email: 'both@example.com' } });
        await quiet(() => requests);
        expect(requests).to.deep.equal(['POST /users/create', 'GET /users/1']);
      });
    });
  });

  describe('on a server that validates bodies with the manifest', () => {
    let app: TestApp | undefined;

    before(async () => {
      const manifest = await appBasicManifest();
      // The fixture's controllers run from src under ts-node, not from the compiled lib the manifest names.
      const started = await startApp([HealthController, UsersController], { ...manifest, app: { ...manifest.app, root: appBasicRoot, outDir: 'src' } });
      app = started.app;
      client = clientFor(started.baseUrl);
    });

    after(() => app?.dispose());

    for (const name of ['React Query', 'SWR']) {
      it(`${name}: rejects an invalid body with a 400 ProblemError listing the errors, on the mutation error`, async () => {
        const library = libraries.find((l) => l.name === name)!;
        let create: MutationResult = {};
        mount(() => (create = library.hooks.useUsersCreate()), [library.provider()]);
        await waitFor(() => (create.mutateAsync ?? create.trigger) !== undefined, 'the mutation hook');
        const rejected = await run(create)({ body: { name: 'no email' } }).catch((e: unknown) => e);
        expect(rejected).to.be.instanceOf(ProblemError);
        expect((rejected as Problem).status).to.equal(400);
        expect((rejected as Problem).problem.errors).to.deep.equal([{ instancePath: '', schemaPath: '#/required', keyword: 'required', params: { missingProperty: 'email' } }]);
        await waitFor(() => create.error != null, 'the mutation error');
        expect(create.error).to.equal(rejected);
        expect(requests).to.deep.equal(['POST /users/create']);
      });
    }
  });
});
