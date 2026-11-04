import 'mocha';
import { expect } from 'chai';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Manifest, RouteEntry } from '@spinajs/manifest';
import { generateClientFiles, type GenerateClientFilesOptions, type GeneratedFile } from '../src/index.js';
import { appBasicManifest } from './support/fixture.js';
import { writeModules, type ModuleDir } from './support/modules.js';
import { REACT_QUERY_PACKAGES, typecheckFiles, type ReactQueryVersion } from './support/typecheck.js';

type ReactQuery = typeof import('@tanstack/react-query');

const source = { line: 1, col: 1, file: 'x.ts', package: 'x' };

function itemsRoute(handler: string, method: RouteEntry['method'], returns: string): RouteEntry {
  return { method, path: '', handler, fullPath: `/items/${handler}`, params: [], returnType: { text: returns }, policies: [], middlewares: [], source };
}

// A GET with an empty reply, a mutation without arguments, and a controller with mutations only.
function withItems(base: Manifest): Manifest {
  const items = { id: 'x:ItemsController', className: 'ItemsController', basePath: 'items', policies: [], middlewares: [], routes: [itemsRoute('ping', 'get', 'void'), itemsRoute('touch', 'post', 'string')], source };
  const jobs = { ...items, id: 'x:JobsController', className: 'JobsController', basePath: 'jobs', routes: [itemsRoute('run', 'post', 'void')] };
  return { ...base, controllers: [...base.controllers, items, jobs] };
}

async function hookFiles(manifest: Manifest, options: Partial<GenerateClientFilesOptions> = {}): Promise<Record<string, string>> {
  const files = await generateClientFiles({ manifest, hooks: ['react-query'], ...options });
  return Object.fromEntries(files.map((f) => [f.path, f.contents]));
}

const snapshot = (name: string) => fileURLToPath(new URL(`./__snapshots__/${name}`, import.meta.url));

function matchSnapshot(name: string, contents: string): void {
  if (!existsSync(snapshot(name))) writeFileSync(snapshot(name), contents);
  expect(contents).to.equal(readFileSync(snapshot(name), 'utf8'));
}

const VERSIONS: ReactQueryVersion[] = ['floor', 'latest'];

const typedApp = [
  "import { QueryClient, useSuspenseQuery } from '@tanstack/react-query';",
  "import { createAppClient, type CreateUserDto, type UserDto, type ValidationProblem } from './client.js';",
  "import { appKeys, type AppClientError } from './client.keys.js';",
  "import { appQueries } from './client.queries.js';",
  "import { useAppClient } from './client.react.js';",
  "import { useHealthGet, useUsersAvatar, useUsersCreate, useUsersGet, useUsersList, type MutationOpts, type QueryOpts } from './client.react-query.js';",
  '',
  'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;',
  '',
  'export function useChecks() {',
  '  const user = useUsersGet({ id: 1 });',
  '  const health = useHealthGet();',
  '  const list = useUsersList({ query: { page: 2 } }, { enabled: false, staleTime: 1 });',
  '  const create = useUsersCreate({',
  '    onSuccess: (data, vars) => {',
  '      const reply: UserDto | ValidationProblem = data;',
  '      const body: CreateUserDto = vars.body;',
  '      return [reply, body];',
  '    },',
  '  });',
  '  const avatar = useUsersAvatar({ invalidate: [appKeys.all, appKeys.users.get({ id: 1 })], retry: 2 });',
  '  const optimistic = useUsersCreate({',
  '    onMutate: () => ({ previous: 1 }),',
  '    onError: (_error, _vars, context) => {',
  '      const previous: number | undefined = context?.previous;',
  '      return previous;',
  '    },',
  '  });',
  '  const suspense = useSuspenseQuery(appQueries.users.get(useAppClient(), { id: 1 }));',
  '  const checks: [',
  '    Equal<typeof user.data, UserDto | undefined>,',
  '    Equal<typeof user.error, AppClientError | null>,',
  '    Equal<typeof health.data, { ok: boolean } | undefined>,',
  '    Equal<typeof list.data, UserDto[] | undefined>,',
  '    Equal<typeof create.data, UserDto | ValidationProblem | undefined>,',
  '    Equal<typeof create.error, AppClientError | null>,',
  '    Equal<Parameters<typeof create.mutate>[0], { body: CreateUserDto }>,',
  '    Equal<Parameters<typeof avatar.mutate>[0], { file: Blob | File; id: number }>,',
  '    Equal<typeof suspense.data, UserDto>,',
  '    Equal<typeof optimistic.context, { previous: number } | undefined>,',
  '  ] = [true, true, true, true, true, true, true, true, true, true];',
  "  create.mutate({ body: { email: 'a@b.c' } });",
  '  // @ts-expect-error mutate needs the body',
  '  create.mutate({});',
  '  useUsersCreate({ invalidate: false });',
  '  // @ts-expect-error the key comes from appQueries',
  "  useUsersGet({ id: 1 }, { queryKey: ['x'] });",
  '  // @ts-expect-error the id is required',
  '  useUsersGet({});',
  '  // @ts-expect-error options never go into the variables slot',
  '  useHealthGet({ staleTime: 1 });',
  '  return checks;',
  '}',
  '',
  'export async function prefetch(): Promise<UserDto | undefined> {',
  "  const client = createAppClient({ baseUrl: 'http://api' });",
  '  const queryClient = new QueryClient();',
  '  await queryClient.prefetchQuery(appQueries.health.get(client));',
  '  const users: UserDto[] = await queryClient.ensureQueryData(appQueries.users.list(client, { query: {} }));',
  '  const user: UserDto = await queryClient.fetchQuery(appQueries.users.get(client, { id: users[0].id }));',
  '  return queryClient.getQueryData(appQueries.users.get(client, { id: user.id }).queryKey);',
  '}',
  '',
  'export const options: [QueryOpts<UserDto>, MutationOpts<void, { id: number }>] = [{ staleTime: 1 }, { invalidate: false }];',
  '',
].join('\n');

describe('React Query emitter', () => {
  let manifest: Manifest;
  let files: Record<string, string>;

  before(async () => {
    manifest = await appBasicManifest();
    files = await hookFiles(manifest);
  });

  it('matches the committed snapshots of client.queries.ts and client.react-query.ts', async () => {
    const named = await hookFiles(manifest, { basename: 'app-basic.client' });
    matchSnapshot('app-basic.client.queries.ts', named['app-basic.client.queries.ts']);
    matchSnapshot('app-basic.client.react-query.ts', named['app-basic.client.react-query.ts']);
  });

  it('writes client.queries.ts server-safe and client.react-query.ts client-only, for react-query only', async () => {
    const environments = (list: GeneratedFile[]) => list.map((f) => [f.path, f.environment]);
    expect(environments(await generateClientFiles({ manifest, hooks: ['react-query'] }))).to.deep.equal([
      ['client.ts', 'server-safe'],
      ['client.keys.ts', 'server-safe'],
      ['client.react.ts', 'client'],
      ['client.queries.ts', 'server-safe'],
      ['client.react-query.ts', 'client'],
    ]);
    expect(Object.keys(await hookFiles(manifest, { hooks: ['swr'] }))).to.not.include.members(['client.queries.ts', 'client.react-query.ts']);
    expect(files['client.queries.ts']).to.not.include('use client');
    expect(files['client.react-query.ts']).to.match(/^\/\*[^\n]*\*\/\n'use client';\n/);
  });

  it('names the sibling modules after basename', async () => {
    const custom = await hookFiles(manifest, { basename: 'api' });
    expect(custom['api.queries.ts']).to.include("from './api.keys.js';").and.include("from './api.js';");
    for (const sibling of ['api.keys.js', 'api.queries.js', 'api.react.js', 'api.js']) expect(custom['api.react-query.ts']).to.include(`from './${sibling}';`);
  });

  for (const version of VERSIONS) {
    for (const react of [18, 19] as const) {
      it(`type-checks against @tanstack/react-query ${version === 'floor' ? '5.0.0' : 'latest'} and React ${react} types, strict, with no unused locals or parameters`, () => {
        const strict = { noUnusedLocals: true, noUnusedParameters: true, react, reactQuery: version };
        expect(typecheckFiles({ ...files, 'app.ts': typedApp }, strict)).to.deep.equal([]);
      });
    }
    it(`type-checks a manifest with an empty GET reply, a mutation without arguments and a controller without queries (${version})`, async () => {
      const app = [
        "import { useItemsPing, useItemsTouch, useJobsRun } from './client.react-query.js';",
        'export function useChecks(): [null | undefined, string | undefined, void] {',
        '  const touch = useItemsTouch();',
        '  touch.mutate({});',
        '  return [useItemsPing().data, touch.data, useJobsRun().mutate({})];',
        '}',
        '',
      ].join('\n');
      const generated = await hookFiles(withItems(manifest));
      expect(generated['client.queries.ts']).to.not.include('jobs:');
      expect(typecheckFiles({ ...generated, 'app.ts': app }, { noUnusedLocals: true, noUnusedParameters: true, reactQuery: version })).to.deep.equal([]);
    });
  }

  it('fails to compile against a client.ts generated from another manifest', () => {
    const stale = files['client.ts'].replace(`manifestHash = '${manifest.hash}'`, "manifestHash = 'other'");
    const errors = typecheckFiles({ ...files, 'client.ts': stale });
    expect(errors.filter((e) => e.startsWith('client.queries.ts: ') || e.startsWith('client.react-query.ts: '))).to.have.length(2);
  });

  // Plan risk 5: the minified app-basic output, with React Query, React and the runtime left external.
  describe('bundle size', function () {
    this.timeout(60000);
    // Measured 841 and 2353 bytes with esbuild 0.28.1; the budgets leave about a quarter for growth.
    const BUDGETS = { 'client.queries.js': 1100, 'client.react-query.js': 3000 };

    for (const [entry, budget] of Object.entries(BUDGETS)) {
      it(`keeps ${entry} with the files it imports within ${budget} bytes`, async () => {
        const { build } = await import('esbuild');
        const modules = writeModules(files);
        try {
          const result = await build({ entryPoints: [modules.path(entry)], bundle: true, minify: true, write: false, format: 'esm', platform: 'neutral', external: ['@tanstack/react-query', 'react', '@spinajs/client/runtime'] });
          const size = result.outputFiles[0].contents.length;
          expect(size, `${entry} is ${size} bytes`).to.be.at.most(budget);
        } finally {
          modules.remove();
        }
      });
    }
  });

  for (const version of VERSIONS) {
    describe(`at runtime, against @tanstack/react-query ${version === 'floor' ? '5.0.0' : 'latest'}`, () => {
      const calls: unknown[][] = [];
      const client = {
        users: {
          get: (id: number) => (calls.push(['users.get', id]), Promise.resolve({ id, email: 'a@b.c' })),
          list: (query: unknown) => (calls.push(['users.list', query]), Promise.resolve([])),
          create: (body: unknown) => (calls.push(['users.create', body]), Promise.resolve({ id: 9, email: 'n@b.c' })),
        },
        health: { get: () => Promise.resolve({ ok: true }) },
        items: { ping: () => Promise.resolve(undefined), touch: () => Promise.resolve('touched') },
      };
      let rq: ReactQuery;
      let modules: ModuleDir;

      before(async () => {
        const url = import.meta.resolve(REACT_QUERY_PACKAGES[version]);
        const runtime = import.meta.resolve('@spinajs/client/runtime');
        rq = (await import(url)) as ReactQuery;
        const stub = [`export * from '${url}';`, 'let queryClient;', 'export const setQueryClient = (c) => { queryClient = c; };', 'export const useQueryClient = () => queryClient;', 'export const useMutation = (options) => options;', ''].join('\n');
        modules = writeModules(
          { ...(await hookFiles(withItems(manifest), { includeSocket: false })), 'react-query-stub.js': stub, 'client.react.ts': 'export const useAppClient = () => globalThis.__appClient;\n' },
          { '@tanstack/react-query': './react-query-stub.js', '@spinajs/client/runtime': runtime },
        );
        (globalThis as { __appClient?: unknown }).__appClient = client;
      });

      after(() => {
        modules.remove();
        delete (globalThis as { __appClient?: unknown }).__appClient;
      });

      beforeEach(() => (calls.length = 0));

      it('prefetches on a server with appQueries: the generated key, the client call, null for an empty reply', async () => {
        const { appQueries } = await modules.import<{ appQueries: Record<string, Record<string, (client: unknown, vars?: unknown) => { queryKey: readonly unknown[] }>> }>('client.queries.js');
        const queryClient = new rq.QueryClient();
        expect(await queryClient.fetchQuery(appQueries.users.get(client, { id: 7 }))).to.deep.equal({ id: 7, email: 'a@b.c' });
        expect(await queryClient.fetchQuery(appQueries.items.ping(client))).to.equal(null);
        await queryClient.prefetchQuery(appQueries.users.list(client, { query: { page: 2 } }));
        expect(calls).to.deep.equal([
          ['users.get', 7],
          ['users.list', { page: 2 }],
        ]);
        expect(queryClient.getQueryCache().getAll().map((q) => q.queryKey)).to.deep.equal([
          ['spinajs', 'users', 'get', { id: 7 }],
          ['spinajs', 'items', 'ping', {}],
          ['spinajs', 'users', 'list', { query: { page: 2 } }],
        ]);
      });

      it('resolves a 204 reply of the client runtime to null instead of failing the query', async () => {
        const { appQueries } = await modules.import<{ appQueries: Record<string, Record<string, (client: unknown, vars?: unknown) => { queryKey: readonly unknown[] }>> }>('client.queries.js');
        const { createAppClient } = await modules.import<{ createAppClient: (options: unknown) => unknown }>('client.js');
        const noContent = createAppClient({ baseUrl: 'http://api', fetch: () => Promise.resolve(new Response(null, { status: 204 })) });
        const queryClient = new rq.QueryClient();
        expect(await queryClient.fetchQuery(appQueries.users.get(noContent, { id: 7 }))).to.equal(null);
        expect(await queryClient.fetchQuery(appQueries.items.ping(noContent))).to.equal(null);
      });

      type Hooks = Record<string, (options?: Record<string, unknown>) => ConstructorParameters<ReactQuery['MutationObserver']>[1]>;

      async function mutationSetup() {
        const hooks = await modules.import<Hooks>('client.react-query.js');
        const stub = await modules.import<{ setQueryClient(c: unknown): void }>('react-query-stub.js');
        const queryClient = new rq.QueryClient();
        stub.setQueryClient(queryClient);
        const log: string[] = [];
        const watch = (queryKey: readonly unknown[]) => {
          const observer = new rq.QueryObserver(queryClient, {
            queryKey,
            queryFn: () => new Promise((resolve) => setTimeout(() => resolve(log.push(`fetched ${queryKey.join(',')}`)), 20)),
          });
          return observer.subscribe(() => undefined);
        };
        const stops = [watch(['spinajs', 'users', 'get', { id: 1 }]), watch(['spinajs', 'articles', 'read', { id: 1 }])];
        while (queryClient.isFetching() > 0) await new Promise((resolve) => setTimeout(resolve, 5));
        log.length = 0;
        const mutate = (hook: string, options: Record<string, unknown> | undefined, vars: unknown) => new rq.MutationObserver(queryClient, hooks[hook](options)).mutate(vars);
        return { log, mutate, stop: () => stops.forEach((stop) => stop()) };
      }

      it("invalidates the controller's queries and resolves only after their refetch, then forwards onSuccess with every argument", async () => {
        const { log, mutate, stop } = await mutationSetup();
        const seen: unknown[][] = [];
        const onSuccess = (...args: unknown[]) => {
          seen.push(args);
          log.push('onSuccess');
        };
        const body = { email: 'n@b.c' };
        const data = await mutate('useUsersCreate', { onSuccess }, { body });
        log.push('settled');
        stop();
        expect(data).to.deep.equal({ id: 9, email: 'n@b.c' });
        expect(calls).to.deep.equal([['users.create', body]]);
        expect(log).to.deep.equal(['fetched spinajs,users,get,[object Object]', 'onSuccess', 'settled']);
        expect(seen[0].slice(0, 2)).to.deep.equal([data, { body }]);
        expect(seen[0].length).to.be.at.least(3);
      });

      it('invalidates nothing with invalidate: false, and exactly the listed keys otherwise', async () => {
        const { log, mutate, stop } = await mutationSetup();
        await mutate('useUsersCreate', { invalidate: false }, { body: {} });
        log.push('none');
        await mutate('useUsersCreate', { invalidate: [['spinajs', 'articles']] }, { body: {} });
        stop();
        expect(log).to.deep.equal(['none', 'fetched spinajs,articles,read,[object Object]']);
      });

      it('refetches a query once when several invalidate keys match it', async () => {
        const { log, mutate, stop } = await mutationSetup();
        await mutate('useUsersCreate', { invalidate: [['spinajs'], ['spinajs', 'users'], ['spinajs', 'users', 'get', { id: 1 }]] }, { body: {} });
        stop();
        expect([...log].sort()).to.deep.equal(['fetched spinajs,articles,read,[object Object]', 'fetched spinajs,users,get,[object Object]']);
      });

      it('keys each mutation, passes other options through, and calls a route without arguments with none', async () => {
        const hooks = await modules.import<Hooks>('client.react-query.js');
        const options = hooks.useUsersCreate({ retry: 2, mutationFn: () => 'ignored' }) as Record<string, unknown>;
        expect([options.mutationKey, options.retry]).to.deep.equal([['spinajs', 'users', 'create'], 2]);
        expect(await (options.mutationFn as (vars: unknown) => Promise<unknown>)({ body: { email: 'x' } })).to.deep.equal({ id: 9, email: 'n@b.c' });
        expect(await (hooks.useItemsTouch().mutationFn as (vars: unknown) => Promise<unknown>)({})).to.equal('touched');
      });
    });
  }
});
