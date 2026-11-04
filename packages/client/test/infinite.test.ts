import 'mocha';
import { expect } from 'chai';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Manifest } from '@spinajs/manifest';
import { buildClientModel, generateClientFiles, type ClientModel, type RouteModel } from '../src/index.js';
import { hookRoutes } from '../src/generate/hooks/shared.js';
import { pagedManifest } from './support/paged.js';
import { writeModules } from './support/modules.js';
import { typecheckFiles, type ReactQueryVersion, type SwrVersion } from './support/typecheck.js';

const snapshot = (name: string) => fileURLToPath(new URL(`./__snapshots__/${name}`, import.meta.url));

function matchSnapshot(name: string, contents: string): void {
  if (!existsSync(snapshot(name))) writeFileSync(snapshot(name), contents);
  expect(contents).to.equal(readFileSync(snapshot(name), 'utf8'));
}

async function generate(manifest: Manifest, basename?: string): Promise<Record<string, string>> {
  const files = await generateClientFiles({ manifest, hooks: ['react-query', 'swr'], ...(basename ? { basename } : {}) });
  return Object.fromEntries(files.map((f) => [f.path, f.contents]));
}

function routeOf(model: ClientModel, controllerKey: string, name: string): RouteModel {
  const found = model.controllers.find((c) => c.key === controllerKey)?.routes.find((r) => r.name === name);
  if (!found) throw new Error(`no route ${controllerKey}.${name}`);
  return found;
}

const PRELUDE = ['type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;', 'const exact = <_T extends true>(): void => undefined;', ''];

const reactQueryApp = [
  "import { QueryClient } from '@tanstack/react-query';",
  "import { createAppClient, type TagDto, type UserDto } from './client.js';",
  "import type { AppClientError } from './client.keys.js';",
  "import { appQueries } from './client.queries.js';",
  "import { useTagsListInfinite, useUsersFeedInfinite, useUsersListInfinite, useUsersZeroInfinite, type InfiniteQueryOpts } from './client.react-query.js';",
  '',
  ...PRELUDE,
  'export function useChecks() {',
  "  const list = useUsersListInfinite({ query: { search: 'a', pageSize: 2 } }, { enabled: false, staleTime: 1 });",
  '  const zero = useUsersZeroInfinite({ query: {} });',
  '  const feed = useUsersFeedInfinite();',
  '  const tags = useTagsListInfinite({ query: { pageSize: 1 } });',
  '  exact<Equal<NonNullable<typeof list.data>["pages"][number]["items"], UserDto[]>>();',
  '  exact<Equal<NonNullable<typeof list.data>["pageParams"][number], number>>();',
  '  exact<Equal<NonNullable<typeof feed.data>["pages"][number]["next"], string | null>>();',
  '  exact<Equal<NonNullable<typeof feed.data>["pageParams"][number], string | null>>();',
  '  exact<Equal<NonNullable<typeof tags.data>["pages"][number]["items"], TagDto[]>>();',
  '  exact<Equal<typeof list.error, AppClientError | null>>();',
  '  const first: UserDto[] | undefined = zero.data?.pages[0].items;',
  '  void list.fetchNextPage();',
  '  // @ts-expect-error the page parameter comes from the hook',
  '  useUsersListInfinite({ query: { page: 2 } });',
  '  // @ts-expect-error the page parameter comes from the hook',
  '  useUsersZeroInfinite({ query: { page: 0 } });',
  "  // @ts-expect-error the cursor comes from the hook",
  "  useUsersFeedInfinite({ cursor: 'x' });",
  '  // @ts-expect-error the key comes from appQueries',
  "  useUsersListInfinite({ query: {} }, { queryKey: ['x'] });",
  '  // @ts-expect-error the page parameters come from appQueries',
  '  useUsersListInfinite({ query: {} }, { initialPageParam: 5 });',
  '  return first;',
  '}',
  '',
  'export async function prefetch(): Promise<UserDto[] | undefined> {',
  "  const client = createAppClient({ baseUrl: 'http://api' });",
  '  const queryClient = new QueryClient();',
  '  const options = appQueries.users.listInfinite(client, { query: {} });',
  '  await queryClient.prefetchInfiniteQuery(options);',
  '  return queryClient.getQueryData(options.queryKey)?.pages[0].items;',
  '}',
  '',
  'export const options: InfiniteQueryOpts<ReturnType<typeof appQueries.users.listInfinite>> = { maxPages: 3 };',
  '',
].join('\n');

const swrApp = [
  "import type { UserDto } from './client.js';",
  "import type { AppClientError } from './client.keys.js';",
  "import { useTagsListInfinite, useUsersFeedInfinite, useUsersListInfinite } from './client.swr.js';",
  '',
  ...PRELUDE,
  'export function useChecks(on: boolean) {',
  '  const list = useUsersListInfinite(on ? { query: {} } : null, { initialSize: 2, revalidateAll: false });',
  '  const feed = useUsersFeedInfinite();',
  '  const tags = useTagsListInfinite(null);',
  '  exact<Equal<typeof list.data, { items: UserDto[]; total: number }[] | undefined>>();',
  '  exact<Equal<typeof feed.data, { items: UserDto[]; next: string | null }[] | undefined>>();',
  '  exact<Equal<typeof list.error, AppClientError | undefined>>();',
  '  void list.setSize(list.size + 1);',
  '  // @ts-expect-error the page parameter comes from the hook',
  '  useUsersListInfinite({ query: { page: 2 } });',
  "  // @ts-expect-error the cursor comes from the hook",
  "  useUsersFeedInfinite({ cursor: 'x' });",
  '  return tags.data?.[0].items;',
  '}',
  '',
].join('\n');

describe('infinite queries', function () {
  this.timeout(120000);
  let manifest: Manifest;
  let files: Record<string, string>;

  before(async () => {
    manifest = await pagedManifest();
    files = await generate(manifest);
  });

  it('records where each paginated route takes its page parameter, and from which page it counts', () => {
    const model = buildClientModel(manifest);
    expect(routeOf(model, 'users', 'list').pagination).to.deep.equal({ kind: 'offset', param: { arg: 'query', path: ['page'] }, firstPage: 1 });
    expect(routeOf(model, 'users', 'zero').pagination).to.deep.equal({ kind: 'offset', param: { arg: 'query', path: ['page'] }, firstPage: 0 });
    expect(routeOf(model, 'users', 'feed').pagination).to.deep.equal({ kind: 'cursor', param: { arg: 'cursor', path: [] } });
    expect(routeOf(model, 'users', 'everyone')).to.not.have.property('pagination');
    expect(routeOf(model, 'users', 'create')).to.not.have.property('pagination');
  });

  it('matches the committed snapshots', async () => {
    const named = await generate(manifest, 'paged-app.client');
    for (const [path, contents] of Object.entries(named)) matchSnapshot(path, contents);
  });

  it('keys an infinite query under its route, never equal to the plain key, and without the page parameter', async () => {
    const modules = writeModules({ 'client.keys.ts': files['client.keys.ts'] });
    try {
      type Key = (vars?: object) => readonly unknown[];
      const { appKeys } = await modules.import<{ appKeys: { users: Record<string, Key> } }>('client.keys.js');
      expect(appKeys.users.listInfinite({ query: { search: 'a' } })).to.deep.equal(['spinajs', 'users', 'list', 'infinite', { query: { search: 'a' } }]);
      expect(appKeys.users.feedInfinite()).to.deep.equal(['spinajs', 'users', 'feed', 'infinite', {}]);
      expect(appKeys.users.list({ query: {} })).to.have.length(4);
    } finally {
      modules.remove();
    }
  });

  it('gives no infinite hook to a page without a page parameter, nor to a mutation', () => {
    for (const file of ['client.keys.ts', 'client.queries.ts', 'client.react-query.ts', 'client.swr.ts']) {
      expect(files[file], file).to.not.match(/everyoneInfinite|EveryoneInfinite|createInfinite|CreateInfinite/);
    }
    expect(files['client.react-query.ts']).to.include('export function useUsersListInfinite(');
    expect(files['client.swr.ts']).to.include('export function useUsersListInfinite(');
  });

  it('refuses a handler whose name the infinite hook of another route would take', () => {
    const users = manifest.controllers.find((c) => c.className === 'UsersController')!;
    const clash = { ...users, routes: [...users.routes, { ...users.routes.find((r) => r.handler === 'everyone')!, handler: 'listInfinite', fullPath: '/users/list-infinite' }] };
    const clashing = { ...manifest, controllers: manifest.controllers.map((c) => (c === users ? clash : c)) };
    expect(() => hookRoutes(buildClientModel(clashing))).to.throw(/the infinite query of UsersController\.list .* would both be useUsersListInfinite/);
  });

  for (const reactQuery of ['floor', 'latest'] as ReactQueryVersion[]) {
    for (const react of [18, 19] as const) {
      it(`type-checks the React Query infinite hooks against ${reactQuery === 'floor' ? '5.0.0' : 'latest'} and React ${react} types`, () => {
        expect(typecheckFiles({ ...files, 'app.ts': reactQueryApp }, { noUnusedLocals: true, noUnusedParameters: true, reactQuery, react })).to.deep.equal([]);
      });
    }
  }

  for (const swr of ['floor', 'latest'] as SwrVersion[]) {
    for (const react of [18, 19] as const) {
      it(`type-checks the SWR infinite hooks against swr ${swr === 'floor' ? '2.2.0' : 'latest'} and React ${react} types`, () => {
        expect(typecheckFiles({ ...files, 'app.ts': swrApp }, { noUnusedLocals: true, noUnusedParameters: true, swr, react })).to.deep.equal([]);
      });
    }
  }
});
