import 'mocha';
import { expect } from 'chai';
import type express from 'express';
import { JSDOM } from 'jsdom';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createElement as h, type ComponentType, type ReactElement, type ReactNode } from 'react';
import { createRoot, hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { dehydrate, HydrationBoundary, QueryClient, QueryClientProvider, type DehydratedState } from '@tanstack/react-query';
import { AccessPolicy, PrincipalMiddleware } from '@spinajs/authz-http';
import { fsService } from '@spinajs/fs';
import { BaseController, Controllers, HttpServer, ServerMiddleware, type Request } from '@spinajs/http';
import { Intl } from '@spinajs/intl';
import { createTestApp, type TestApp } from '@spinajs/testing';
import { HealthController } from '../../compiler/test/fixtures/app-basic/src/controllers/HealthController.js';
import { UsersController } from '../../compiler/test/fixtures/app-basic/src/controllers/users.js';
import { generateClientFiles } from '../src/index.js';
import type { AppClient, UserDto } from './__snapshots__/app-basic.client.js';
import { appBasicManifest } from './support/fixture.js';
import { AllowAccess, E2eConfiguration } from './support/harness.js';
import { writeModules, type ModuleDir } from './support/modules.js';

const seenByServer: { path: string; headers: IncomingHttpHeaders }[] = [];

class RecordHeaders extends ServerMiddleware {
  constructor() {
    super();
    this.Order = 0;
  }

  public before() {
    return (req: Request, _res: express.Response, next: express.NextFunction) => {
      seenByServer.push({ path: req.path, headers: { ...req.headers } });
      next();
    };
  }

  public after() {
    return null;
  }
}

interface Generated {
  createAppClient(options: { baseUrl: string; fetch?: typeof fetch }): AppClient;
  createServerAppClient(options: { baseUrl: string; incoming?: Headers; forward?: string[] }): AppClient;
  appKeys: { users: { get(vars: { id: number }): readonly unknown[] } };
  appQueries: { users: { get(client: AppClient, vars: { id: number }): { queryKey: readonly unknown[]; queryFn: () => Promise<UserDto> } } };
  AppClientProvider: ComponentType<{ client: AppClient; children?: ReactNode }>;
  useQueryUser(vars: { id: number }): { data?: UserDto; status: string };
  useSwrUser(vars: { id: number } | null): { data?: UserDto };
}

interface Swr {
  SWRConfig: ComponentType<{ value: object; children?: ReactNode }>;
  unstable_serialize(key: unknown): string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, what: string, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

const GLOBALS = ['window', 'document', 'navigator'] as const;

// The browser-side client: it must not be called when the server's answer is hydrated.
function countingClient(generated: Generated, baseUrl: string): { client: AppClient; calls: string[] } {
  const calls: string[] = [];
  const fetchCounted: typeof fetch = (input, init) => {
    calls.push(input instanceof Request ? input.url : input.toString());
    return fetch(input, init);
  };
  return { client: generated.createAppClient({ baseUrl, fetch: fetchCounted }), calls };
}

// React and SWR warn about effects in renderToString, because jsdom defines `window` for the whole suite.
function serverRender(tree: ReactElement): string {
  const { error } = console;
  console.error = () => undefined;
  try {
    return renderToString(tree);
  } finally {
    console.error = error;
  }
}

describe('SSR prefetch and hydration against the booted app-basic', function () {
  this.timeout(60000);

  let app: TestApp;
  let baseUrl: string;
  let host: string;
  let modules: ModuleDir;
  let generated: Generated;
  let swr: Swr;
  let dom: JSDOM;
  let root: Root | undefined;
  let saved: Partial<Record<(typeof GLOBALS)[number], PropertyDescriptor>>;

  // What a Server Component reads with `await headers()`: the browser's request, as the Next.js server received it.
  const incoming = () =>
    new Headers({
      cookie: 'session=abc',
      authorization: 'Bearer t0k',
      host: 'evil.example',
      'x-forwarded-for': '10.0.0.1',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'http',
      'accept-language': 'pl',
      'content-length': '5',
    });

  before(async () => {
    app = await createTestApp({
      configuration: E2eConfiguration,
      register: (c) => {
        c.unregister(ServerMiddleware, PrincipalMiddleware);
        for (const controller of [HealthController, UsersController]) c.register(controller).as(BaseController);
        c.register(AllowAccess).as(AccessPolicy);
        c.register(RecordHeaders).as(ServerMiddleware);
      },
      resolve: [fsService, Intl, Controllers],
      bootTimeout: 50000,
    });
    await (await app.resolve(HttpServer)).start();
    const { port } = (app.container.get(HttpServer) as HttpServer).Server.address() as AddressInfo;
    host = `127.0.0.1:${port}`;
    baseUrl = `http://${host}`;

    const files = await generateClientFiles({ manifest: await appBasicManifest(), hooks: ['react-query', 'swr'], server: true, includeSocket: false });
    const resolved = ['react', '@tanstack/react-query', 'swr', 'swr/mutation', '@spinajs/client/runtime'].map((name) => [name, import.meta.resolve(name)]);
    const index = [
      "export { createAppClient } from './client.js';",
      "export { createServerAppClient } from './client.server.js';",
      "export { appKeys } from './client.keys.js';",
      "export { appQueries } from './client.queries.js';",
      "export { AppClientProvider } from './client.react.js';",
      "export { useUsersGet as useQueryUser } from './client.react-query.js';",
      "export { useUsersGet as useSwrUser } from './client.swr.js';",
      '',
    ].join('\n');
    modules = writeModules({ ...Object.fromEntries(files.map((f) => [f.path, f.contents])), 'index.js': index }, Object.fromEntries(resolved));

    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
    saved = Object.fromEntries(GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    for (const name of GLOBALS) Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true });
    // Loaded with `window` defined, as the other SWR suites load it: SWR reads the environment once, at module load.
    generated = await modules.import<Generated>('index.js');
    swr = (await import(import.meta.resolve('swr'))) as Swr;
  });

  after(async () => {
    for (const name of GLOBALS) {
      const descriptor = saved[name];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
    modules.remove();
    await app.dispose();
  });

  beforeEach(() => {
    seenByServer.length = 0;
  });

  afterEach(() => {
    root?.unmount();
    root = undefined;
  });

  const container = () => dom.window.document.getElementById('root') as HTMLElement;

  // Hydrates server HTML the way a browser would and collects what React reports: a mismatch is an error here.
  async function hydrate(html: string, tree: ReactElement): Promise<unknown[]> {
    const errors: unknown[] = [];
    const { error } = console;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      container().innerHTML = html;
      root = hydrateRoot(container(), tree, { onRecoverableError: (e) => errors.push(e) });
      await sleep(100);
    } finally {
      console.error = error;
    }
    return errors;
  }

  function expectForwarded(path: string): void {
    expect(seenByServer.map((r) => r.path)).to.deep.equal([path]);
    const [{ headers }] = seenByServer;
    expect(headers).to.include({ cookie: 'session=abc', authorization: 'Bearer t0k', host });
    expect(headers).to.not.have.any.keys('x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'content-length');
    // Node's fetch sends its own `accept-language: *`; the browser's `pl` must not reach the API.
    expect(headers['accept-language']).to.not.equal('pl');
  }

  describe('React Query: appQueries, prefetchQuery, dehydrate and HydrationBoundary', () => {
    const UserEmail = () => {
      const { data, status } = generated.useQueryUser({ id: 1 });
      return h('span', null, data ? data.email : status);
    };

    const tree = (queryClient: QueryClient, client: AppClient, state?: DehydratedState) => {
      const view = h(generated.AppClientProvider, { client }, h(UserEmail));
      return h(QueryClientProvider, { client: queryClient }, state ? h(HydrationBoundary, { state }, view) : view);
    };

    const browserQueryClient = () => new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: false } } });

    async function prefetchOnServer(): Promise<DehydratedState> {
      const client = generated.createServerAppClient({ baseUrl, incoming: incoming() });
      const queryClient = new QueryClient();
      await queryClient.prefetchQuery(generated.appQueries.users.get(client, { id: 1 }));
      // The state crosses the RSC boundary as JSON.
      return JSON.parse(JSON.stringify(dehydrate(queryClient))) as DehydratedState;
    }

    it('prefetches through createServerAppClient, forwarding cookie and authorization but not host or x-forwarded-*', async () => {
      const state = await prefetchOnServer();
      expectForwarded('/users/1');
      expect(state.queries.map((q) => [q.queryKey, q.state.data])).to.deep.equal([[generated.appKeys.users.get({ id: 1 }), { id: 1, email: 'ada@example.com', name: 'Ada' }]]);
    });

    it('renders the prefetched user on the server and hydrates it in the browser without a second request', async () => {
      const state = await prefetchOnServer();
      const browser = countingClient(generated, baseUrl);
      const html = serverRender(tree(browserQueryClient(), browser.client, state));
      expect(html).to.include('ada@example.com');
      expect(await hydrate(html, tree(browserQueryClient(), browser.client, state))).to.deep.equal([]);
      expect(container().textContent).to.equal('ada@example.com');
      expect(browser.calls).to.deep.equal([]);
      expect(seenByServer).to.have.length(1);
    });

    it('fetches in the browser without the dehydrated state, so the counter above can see a request', async () => {
      const browser = countingClient(generated, baseUrl);
      root = createRoot(container());
      root.render(tree(browserQueryClient(), browser.client));
      await waitFor(() => container().textContent === 'ada@example.com', 'the browser fetch');
      expect(browser.calls).to.deep.equal([`${baseUrl}/users/1`]);
    });

    it('refetches the hydrated query on mount when the browser QueryClient keeps staleTime 0', async () => {
      const state = await prefetchOnServer();
      const browser = countingClient(generated, baseUrl);
      root = createRoot(container());
      root.render(tree(new QueryClient({ defaultOptions: { queries: { retry: false } } }), browser.client, state));
      await waitFor(() => browser.calls.length === 1, 'the refetch of stale hydrated data');
      expect(container().textContent).to.equal('ada@example.com');
    });
  });

  describe('SWR: fallback keyed by unstable_serialize(appKeys...)', () => {
    const UserEmail = () => h('span', null, generated.useSwrUser({ id: 1 }).data?.email ?? 'loading');

    const tree = (client: AppClient, fallback: Record<string, unknown>, config: object = { revalidateIfStale: false }) =>
      h(swr.SWRConfig, { value: { provider: () => new Map(), fallback, ...config } }, h(generated.AppClientProvider, { client }, h(UserEmail)));

    async function fallbackOnServer(): Promise<Record<string, unknown>> {
      const user = await generated.createServerAppClient({ baseUrl, incoming: incoming() }).users.get(1);
      return JSON.parse(JSON.stringify({ [swr.unstable_serialize(generated.appKeys.users.get({ id: 1 }))]: user })) as Record<string, unknown>;
    }

    it('renders the fallback on the server and hydrates it without a second request', async () => {
      const fallback = await fallbackOnServer();
      expectForwarded('/users/1');
      const browser = countingClient(generated, baseUrl);
      const html = serverRender(tree(browser.client, fallback));
      expect(html).to.include('ada@example.com');
      expect(await hydrate(html, tree(browser.client, fallback))).to.deep.equal([]);
      expect(container().textContent).to.equal('ada@example.com');
      expect(browser.calls).to.deep.equal([]);
    });

    it('does not hydrate from a fallback keyed by the key array itself', async () => {
      const user = await generated.createServerAppClient({ baseUrl }).users.get(1);
      const browser = countingClient(generated, baseUrl);
      expect(serverRender(tree(browser.client, { [String(generated.appKeys.users.get({ id: 1 }))]: user }))).to.include('loading');
    });

    it('revalidates the fallback on mount with SWR defaults', async () => {
      const fallback = await fallbackOnServer();
      const browser = countingClient(generated, baseUrl);
      root = createRoot(container());
      root.render(tree(browser.client, fallback, {}));
      await waitFor(() => browser.calls.length === 1, 'the revalidation of the fallback');
      expect(container().textContent).to.equal('ada@example.com');
    });
  });
});
