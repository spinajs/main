import 'mocha';
import { expect } from 'chai';
import { createElement, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TestApp } from '@spinajs/testing';
import { generateClientFiles } from '../src/index.js';
import { resetUsers, TagsController, UsersController } from './fixtures/paged-app/src/controllers.js';
import { startApp } from './support/harness.js';
import { installDom, quiet, waitFor, withAliasedImports, writeModules, type Dom, type ModuleDir } from './support/modules.js';
import { pagedManifest } from './support/paged.js';

/** Requests per path, as the counting fetch saw them. */
type Requests = Record<string, number>;

// Returns once no request has been sent for a whole quiet period.
const settled = (requests: Requests) => quiet(() => requests, 100);

interface Page { items: { id: number; name: string }[]; total?: number; next?: string | null }
interface Infinite { data?: { pages: Page[]; pageParams: unknown[] }; hasNextPage: boolean; fetchNextPage(): Promise<Infinite> }
interface SwrInfinite { data?: Page[]; size: number; setSize: (size: number) => Promise<unknown> }
type Hook<T> = (vars?: unknown, options?: unknown) => T;
interface Loaded {
  module: ModuleDir;
  createAppClient(options: { baseUrl: string; fetch: typeof fetch }): unknown;
  AppClientProvider: ComponentType<{ client: unknown; children?: ReactNode }>;
  hooks: Record<string, Hook<unknown>>;
  Provider: (children: ReactNode) => ReactNode;
}

const runtimeUrl = import.meta.resolve('@spinajs/client/runtime');

const LIBRARIES = [
  { label: 'React Query 5.0.0', kind: 'react-query', package: '@tanstack/react-query-5.0' },
  { label: 'React Query latest', kind: 'react-query', package: '@tanstack/react-query' },
  { label: 'swr 2.2.0', kind: 'swr', package: 'swr-floor' },
  { label: 'swr latest', kind: 'swr', package: 'swr' },
] as const;

describe('infinite hooks against a booted paged-app', function () {
  this.timeout(120000);

  let app: TestApp;
  let baseUrl: string;
  let files: Record<string, string>;
  let dom: Dom;

  before(async () => {
    ({ app, baseUrl } = await startApp([UsersController, TagsController]));
    const generated = await generateClientFiles({ manifest: await pagedManifest(), hooks: ['react-query', 'swr'] });
    files = Object.fromEntries(generated.map((f) => [f.path, f.contents]));
    dom = installDom();
  });

  after(async () => {
    dom.restore();
    await app.dispose();
  });

  for (const library of LIBRARIES) {
    describe(library.label, () => {
      let loaded: Loaded;
      let root: Root | undefined;
      let requests: Requests;
      /** Path and query of every request, in order. */
      let sent: string[];

      before(async () => {
        const sub = (path: string) => import.meta.resolve(`${library.package}${path}`);
        const libraries: Record<string, string> =
          library.kind === 'swr' ? { swr: sub(''), 'swr/infinite': sub('/infinite'), 'swr/mutation': sub('/mutation') } : { '@tanstack/react-query': sub('') };
        const hooksFile = library.kind === 'swr' ? 'client.swr.js' : 'client.react-query.js';
        const module = writeModules(files, { react: import.meta.resolve('react'), '@spinajs/client/runtime': runtimeUrl, ...libraries });
        const load = async () => {
          const [client, react, hooks, lib] = await Promise.all([
            module.import<Pick<Loaded, 'createAppClient'>>('client.js'),
            module.import<Pick<Loaded, 'AppClientProvider'>>('client.react.js'),
            module.import<Loaded['hooks']>(hooksFile),
            import(libraries[library.kind === 'swr' ? 'swr' : '@tanstack/react-query']) as Promise<Record<string, ComponentType<{ client?: unknown; value?: object; children?: ReactNode }> & (new (options: object) => unknown)>>,
          ]);
          const Provider = (children: ReactNode): ReactNode => {
            if (library.kind === 'swr') return createElement(lib.SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0, revalidateOnFocus: false, errorRetryCount: 0 } }, children);
            const queryClient = new lib.QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
            return createElement(lib.QueryClientProvider, { client: queryClient }, children);
          };
          loaded = { module, createAppClient: client.createAppClient, AppClientProvider: react.AppClientProvider, hooks, Provider };
        };
        await (library.package === 'swr-floor' ? withAliasedImports('swr-floor', 'swr', load) : load());
      });

      after(() => loaded.module.remove());

      beforeEach(() => {
        requests = {};
        sent = [];
        resetUsers(5);
      });

      afterEach(() => {
        root?.unmount();
        root = undefined;
      });

      async function mount<T>(use: () => T): Promise<{ current: () => T }> {
        const counting: typeof fetch = (input, init) => {
          const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
          requests[path] = (requests[path] ?? 0) + 1;
          const url = new URL(String(input instanceof Request ? input.url : input));
          sent.push(decodeURIComponent(url.pathname + url.search));
          return fetch(input, init);
        };
        const client = loaded.createAppClient({ baseUrl, fetch: counting });
        let latest: T | undefined;
        const Probe = () => {
          latest = use();
          return null;
        };
        root = createRoot(dom.document.body.appendChild(dom.document.createElement('div')));
        root.render(loaded.Provider(createElement(loaded.AppClientProvider, { client }, createElement(Probe))));
        await waitFor(() => latest !== undefined, 'the first render', 10000);
        return { current: () => latest as T };
      }

      const ids = (pages: Page[] | undefined) => (pages ?? []).map((p) => p.items.map((u) => u.id));

      if (library.kind === 'react-query') {
        // The server clamps every page to 2 items, whatever pageSize asks for.
        async function readAll(result: { current: () => Infinite }): Promise<Infinite> {
          await waitFor(() => result.current().data !== undefined, 'the first page');
          // The result fetchNextPage resolves with is current; the rendered one catches up later.
          let last = result.current();
          for (let pages = 0; last.hasNextPage; pages++) {
            if (pages > 10) throw new Error(`still has a next page: ${JSON.stringify(requests)}`);
            last = await last.fetchNextPage();
          }
          await settled(requests);
          await waitFor(() => result.current().data?.pages.length === last.data?.pages.length, 'the render of the last page');
          return result.current();
        }

        it('pages an offset route from page 1 until the items reach total, although the server clamps the page size', async () => {
          const result = await mount(() => loaded.hooks.useUsersListInfinite({ query: { pageSize: 10 } }) as Infinite);
          const done = await readAll(result);
          expect(ids(done.data?.pages)).to.deep.equal([[1, 2], [3, 4], [5]]);
          expect(done.data?.pageParams).to.deep.equal([1, 2, 3]);
          expect(requests).to.deep.equal({ '/users/list': 3 });
        });

        it('stops after the last full page when the total is a multiple of the page size', async () => {
          resetUsers(4);
          const done = await readAll(await mount(() => loaded.hooks.useUsersListInfinite({ query: {} }) as Infinite));
          expect(ids(done.data?.pages)).to.deep.equal([[1, 2], [3, 4]]);
          expect(requests).to.deep.equal({ '/users/list': 2 });
        });

        it('starts a zero-based route at page 0', async () => {
          const done = await readAll(await mount(() => loaded.hooks.useUsersZeroInfinite({ query: {} }) as Infinite));
          expect(ids(done.data?.pages)).to.deep.equal([[1, 2], [3, 4], [5]]);
          expect(done.data?.pageParams).to.deep.equal([0, 1, 2]);
        });

        it('follows a cursor until next is null', async () => {
          const done = await readAll(await mount(() => loaded.hooks.useUsersFeedInfinite() as Infinite));
          expect(ids(done.data?.pages)).to.deep.equal([[1, 2], [3, 4], [5]]);
          expect(done.data?.pageParams).to.deep.equal([null, '2', '4']);
          expect(requests).to.deep.equal({ '/users/feed': 3 });
        });

        it('ends at an empty reply, which an optional page may send, as an empty page', async () => {
          const done = await readAll(await mount(() => loaded.hooks.useUsersSparseInfinite() as Infinite));
          expect(ids(done.data?.pages)).to.deep.equal([[1, 2], []]);
          expect(requests).to.deep.equal({ '/users/sparse': 2 });
        });

        it('refetches every page of the infinite query and the plain query of the mutated controller, and nothing of another', async () => {
          const result = await mount(() => ({
            list: loaded.hooks.useUsersList({ query: {} }) as { data?: Page },
            infinite: loaded.hooks.useUsersListInfinite({ query: {} }) as Infinite,
            tags: loaded.hooks.useTagsListInfinite({ query: {} }) as Infinite,
            create: loaded.hooks.useUsersCreate() as { mutateAsync(vars: object): Promise<unknown> },
          }));
          await waitFor(() => result.current().list.data !== undefined && result.current().tags.data !== undefined, 'the plain and the tags queries');
          await readAll({ current: () => result.current().infinite });
          expect(requests).to.deep.equal({ '/users/list': 4, '/tags/list': 1 });
          await result.current().create.mutateAsync({ body: { name: 'new' } });
          await settled(requests);
          expect(requests).to.deep.equal({ '/users/list': 8, '/tags/list': 1, '/users/create': 1 });
          expect(ids(result.current().infinite.data?.pages)).to.deep.equal([[6, 1], [2, 3], [4, 5]]);
          expect(result.current().list.data?.items.map((u) => u.id)).to.deep.equal([6, 1]);
        });
      } else {
        // revalidateFirstPage off, so a size change asks only for the new pages.
        const CONFIG = { revalidateFirstPage: false };
        // SWR reads `data` lazily and re-renders only for what a render read, so the probe reads it while rendering.
        const snap = (r: SwrInfinite): SwrInfinite => ({ data: r.data, size: r.size, setSize: r.setSize });
        const list = (query: string) => `/users/list?query=${query}`;

        // Asks for one page more than there are: the page keys must end before it.
        async function grow(result: { current: () => SwrInfinite }, size: number): Promise<SwrInfinite> {
          await waitFor(() => result.current().data !== undefined, 'the first page');
          for (let n = 2; n <= size; n++) await result.current().setSize(n);
          await settled(requests);
          return result.current();
        }

        // swr 2.5 refetches the last page when asked for a size past the end; which pages are asked for is what counts.
        const pagesAsked = () => [...new Set(sent)];

        it('pages an offset route from page 1 and asks for no page past total, although the server clamps the page size', async () => {
          const done = await grow(await mount(() => snap(loaded.hooks.useUsersListInfinite({ query: { pageSize: 10 } }, CONFIG) as SwrInfinite)), 4);
          expect(ids(done.data)).to.deep.equal([[1, 2], [3, 4], [5]]);
          expect(pagesAsked()).to.deep.equal([1, 2, 3].map((page) => list(`{"pageSize":10,"page":${page}}`)));
        });

        it('stops after the last full page when the total is a multiple of the page size', async () => {
          resetUsers(4);
          const done = await grow(await mount(() => snap(loaded.hooks.useUsersListInfinite({ query: {} }, CONFIG) as SwrInfinite)), 3);
          expect(ids(done.data)).to.deep.equal([[1, 2], [3, 4]]);
          expect(pagesAsked()).to.deep.equal([list('{"page":1}'), list('{"page":2}')]);
        });

        it('starts a zero-based route at page 0', async () => {
          const done = await grow(await mount(() => snap(loaded.hooks.useUsersZeroInfinite({ query: {} }, CONFIG) as SwrInfinite)), 4);
          expect(ids(done.data)).to.deep.equal([[1, 2], [3, 4], [5]]);
          expect(pagesAsked()).to.deep.equal(['/users/zero?page=0', '/users/zero?page=1', '/users/zero?page=2']);
        });

        it('follows a cursor until next is null', async () => {
          const done = await grow(await mount(() => snap(loaded.hooks.useUsersFeedInfinite({}, CONFIG) as SwrInfinite)), 4);
          expect(ids(done.data)).to.deep.equal([[1, 2], [3, 4], [5]]);
          expect(pagesAsked()).to.deep.equal(['/users/feed', '/users/feed?cursor=2', '/users/feed?cursor=4']);
        });

        it('ends at an empty reply, which an optional page may send, as an empty page', async () => {
          const done = await grow(await mount(() => snap(loaded.hooks.useUsersSparseInfinite({}, CONFIG) as SwrInfinite)), 3);
          expect(ids(done.data)).to.deep.equal([[1, 2], []]);
          expect(pagesAsked()).to.deep.equal(['/users/sparse?page=1', '/users/sparse?page=2']);
        });

        it('pages in order and stops at total when the app asks for parallel pages', async () => {
          const done = await grow(await mount(() => snap(loaded.hooks.useUsersListInfinite({ query: {} }, { ...CONFIG, parallel: true }) as SwrInfinite)), 4);
          expect(ids(done.data)).to.deep.equal([[1, 2], [3, 4], [5]]);
          expect(pagesAsked()).to.deep.equal([1, 2, 3].map((page) => list(`{"page":${page}}`)));
        });

        it('sends nothing for null variables', async () => {
          await mount(() => snap(loaded.hooks.useUsersListInfinite(null) as SwrInfinite));
          await settled(requests);
          expect(sent).to.deep.equal([]);
        });

        it('revalidates every page of the infinite hook and the plain hook of the mutated controller, and nothing of another', async () => {
          const result = await mount(() => {
            const plain = loaded.hooks.useUsersList({ query: {} }) as { data?: Page };
            return {
              list: { data: plain.data },
              infinite: snap(loaded.hooks.useUsersListInfinite({ query: {} }, CONFIG) as SwrInfinite),
              tags: snap(loaded.hooks.useTagsListInfinite({ query: {} }, CONFIG) as SwrInfinite),
              create: loaded.hooks.useUsersCreate() as { trigger(vars: object): Promise<unknown> },
            };
          });
          await waitFor(() => result.current().list.data !== undefined && result.current().tags.data !== undefined, 'the plain and the tags hooks');
          await grow({ current: () => result.current().infinite }, 3);
          sent = [];
          await result.current().create.trigger({ body: { name: 'new' } });
          await settled(requests);
          expect([...sent].sort()).to.deep.equal(['/users/create', list('{"page":1}'), list('{"page":2}'), list('{"page":3}'), list('{}')]);
          await waitFor(() => ids(result.current().infinite.data)[0]?.[0] === 6, 'the render of the refetched pages');
          expect(ids(result.current().infinite.data)).to.deep.equal([[6, 1], [2, 3], [4, 5]]);
          expect(result.current().list.data?.items.map((u) => u.id)).to.deep.equal([6, 1]);
        });
      }
    });
  }
});
