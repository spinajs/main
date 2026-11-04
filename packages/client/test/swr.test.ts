import 'mocha';
import { expect } from 'chai';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Manifest, RouteEntry } from '@spinajs/manifest';
import { generateClientFiles, GENERATOR_TARGETS, type GenerateClientFilesOptions } from '../src/index.js';
import { appBasicManifest } from './support/fixture.js';
import { typecheckFiles, type SwrVersion } from './support/typecheck.js';

const snapshot = (name: string) => fileURLToPath(new URL(`./__snapshots__/${name}`, import.meta.url));

function matchSnapshot(name: string, contents: string): void {
  if (!existsSync(snapshot(name))) writeFileSync(snapshot(name), contents);
  expect(contents).to.equal(readFileSync(snapshot(name), 'utf8'));
}

const source = { line: 1, col: 1, file: 'x.ts', package: 'x' };

const itemsRoute = (handler: string, method: RouteEntry['method'], returns: string): RouteEntry => ({ method, path: '', handler, fullPath: `/items/${handler}`, params: [], returnType: { text: returns }, policies: [], middlewares: [], source });

// The only route of this manifest is a query with an empty reply, so the file needs no nullIfEmpty helper.
function voidOnly(base: Manifest): Manifest {
  const routes = [itemsRoute('ping', 'get', 'void')];
  return { ...base, controllers: [{ id: 'x:ItemsController', className: 'ItemsController', basePath: 'items', policies: [], middlewares: [], routes, source }], controllerBases: [] };
}

const voidApp = [
  "import { useItemsPing } from './client.swr.js';",
  '',
  'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;',
  'const exact = <_T extends true>(): void => undefined;',
  '',
  'export function app() {',
  '  const ping = useItemsPing();',
  '  exact<Equal<typeof ping.data, null | undefined>>();',
  '  return ping;',
  '}',
  '',
].join('\n');

async function generate(manifest: Manifest, options: Partial<GenerateClientFilesOptions> = {}): Promise<Record<string, string>> {
  const files = await generateClientFiles({ manifest, hooks: ['swr'], ...options });
  return Object.fromEntries(files.map((f) => [f.path, f.contents]));
}

// Every hook in the shape an app writes it: conditional fetch, config, mutation options.
const typedApp = [
  "import { appKeys, type AppClientError } from './client.keys.js';",
  "import type { ArticleDto, CreateUserDto, UserDto, ValidationProblem } from './client.js';",
  "import type { MutationConfig, MutationResult } from './client.swr.js';",
  "import { useArticlesAdd, useArticlesRead, useHealthGet, useUsersAvatar, useUsersCreate, useUsersGet, useUsersList } from './client.swr.js';",
  '',
  'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;',
  'const exact = <_T extends true>(): void => undefined;',
  'export type Wrapped = MutationResult<UserDto, { body: CreateUserDto }>;',
  '',
  'export async function app(id: number | null) {',
  '  const user = useUsersGet(id === null ? null : { id });',
  '  const loaded: UserDto | undefined = user.data;',
  '  const failure: AppClientError | undefined = user.error;',
  '  exact<Equal<typeof user.data, UserDto | undefined>>();',
  '  exact<Equal<typeof user.error, AppClientError | undefined>>();',
  '  const idle = useUsersGet(null);',
  '  const polled = useUsersGet({ id: 1 }, { refreshInterval: 1000, onSuccess: (data) => data.email });',
  '  const list = useUsersList({ query: { page: 2 } });',
  '  const listed: UserDto[] | undefined = list.data;',
  '  const article = useArticlesRead({ id: 1 });',
  '  const read: ArticleDto | undefined = article.data;',
  '  const health = useHealthGet();',
  '  const healthEmpty = useHealthGet({});',
  '  const healthOff = useHealthGet(null);',
  '  const healthPolled = useHealthGet({}, { refreshInterval: 1 });',
  '  const healthOk: boolean | undefined = health.data?.ok;',
  '',
  '  const create = useUsersCreate();',
  '  const created: UserDto | ValidationProblem | undefined = await create.trigger({ body: { email: "a@b.c" } });',
  '  const running: boolean = create.isMutating;',
  '  exact<Equal<typeof create.data, UserDto | ValidationProblem | undefined>>();',
  '  exact<Equal<typeof create.error, AppClientError | undefined>>();',
  '  exact<Equal<NonNullable<Awaited<ReturnType<typeof create.trigger>>>, UserDto | ValidationProblem>>();',
  '  const config: MutationConfig<UserDto, { body: CreateUserDto }> = { invalidate: false };',
  '  const quiet = useUsersCreate({ invalidate: false });',
  '  const targeted = useUsersCreate({',
  '    invalidate: [appKeys.users.get({ id: 1 }), appKeys.articles.all, appKeys.health.get()],',
  '    onSuccess: (data) => data,',
  '  });',
  '  const articleAdd = useArticlesAdd();',
  '  const avatar = useUsersAvatar();',
  '  const done: void | undefined = await avatar.trigger({ id: 1, file: new Blob() });',
  '',
  '  // @ts-expect-error the id is required',
  '  useUsersGet({});',
  '  // @ts-expect-error required variables cannot be left out',
  '  useUsersGet();',
  '  // @ts-expect-error options are not variables',
  '  useHealthGet({ refreshInterval: 1 });',
  '  // @ts-expect-error the body is required',
  '  await create.trigger({});',
  '  // @ts-expect-error invalidate takes keys',
  "  useUsersCreate({ invalidate: ['users'] });",
  '  // @ts-expect-error the data is a UserDto',
  '  const wrong: ArticleDto | undefined = user.data;',
  '  return [user, loaded, failure, idle, polled, list, listed, article, read, health, healthEmpty, healthOff, healthPolled, healthOk, create, created, running, quiet, targeted, articleAdd, avatar, done, wrong, config];',
  '}',
  '',
].join('\n');

describe('SWR hooks', () => {
  let manifest: Manifest;
  let files: Record<string, string>;

  before(async () => {
    manifest = await appBasicManifest();
    files = await generate(manifest);
  });

  it('is an available target and adds client.swr.ts after the shared files', () => {
    expect(GENERATOR_TARGETS.swr.available).to.equal(true);
    expect(Object.keys(files)).to.deep.equal(['client.ts', 'client.keys.ts', 'client.react.ts', 'client.swr.ts']);
  });

  it('marks client.swr.ts as a client file that starts with the directive', async () => {
    const [, , , swr] = await generateClientFiles({ manifest, hooks: ['swr'] });
    expect(swr.environment).to.equal('client');
    expect(swr.contents.split('\n')[1]).to.equal("'use client';");
  });

  it('matches the committed snapshot', async () => {
    const named = await generate(manifest, { basename: 'app-basic.client' });
    matchSnapshot('app-basic.client.swr.ts', named['app-basic.client.swr.ts']);
  });

  it('leaves every other file as the React Query-only run writes it, and adds nothing without the swr target', async () => {
    const withQuery = await generate(manifest, { hooks: ['react-query'] });
    const both = await generate(manifest, { hooks: ['react-query', 'swr'] });
    expect(Object.keys(withQuery)).to.not.include('client.swr.ts');
    for (const path of Object.keys(withQuery)) expect(both[path], path).to.equal(withQuery[path]);
    expect(Object.keys(both)).to.include('client.swr.ts');
    const plain = await generate(manifest, { hooks: [] });
    expect(Object.keys(plain)).to.deep.equal(['client.ts']);
  });

  it('names the sibling modules after basename and imports the types from the client module', async () => {
    const custom = await generate(manifest, { basename: 'api' });
    expect(custom['api.swr.ts']).to.include("from './api.keys.js';").and.include("from './api.react.js';").and.include("from './api.js';");
  });

  it('starts keys from keyPrefix without changing the hooks', async () => {
    const custom = await generate(manifest, { keyPrefix: 'app' });
    expect(custom['client.swr.ts']).to.equal(files['client.swr.ts']);
    expect(custom['client.keys.ts']).to.include("['app', 'users', 'get', vars]");
  });

  const matrix: [SwrVersion, 18 | 19][] = [
    ['floor', 18],
    ['floor', 19],
    ['latest', 18],
    ['latest', 19],
  ];
  for (const [swr, react] of matrix) {
    it(`type-checks, strict with noUnusedLocals, against swr ${swr} and React ${react}, and types every hook call`, () => {
      expect(typecheckFiles({ ...files, 'app.ts': typedApp }, { noUnusedLocals: true, react, swr })).to.deep.equal([]);
    });
  }

  it('types an empty-reply query as null, and leaves the nullIfEmpty helper out when no query needs it', async () => {
    const generated = await generate(voidOnly(manifest));
    expect(generated['client.swr.ts']).to.include('client.items.ping().then(() => null)').and.not.include('nullIfEmpty');
    expect(typecheckFiles({ ...generated, 'app.ts': voidApp }, { noUnusedLocals: true, swr: 'latest' })).to.deep.equal([]);
  });

  it('fails to compile against a client.ts generated from another manifest', () => {
    const stale = files['client.ts'].replace(`manifestHash = '${manifest.hash}'`, "manifestHash = 'other'");
    const errors = typecheckFiles({ ...files, 'client.ts': stale });
    expect(errors.filter((e) => e.startsWith('client.swr.ts: '))).to.have.length(1);
  });
});
