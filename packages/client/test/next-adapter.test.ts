import 'mocha';
import { expect } from 'chai';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type { Manifest } from '@spinajs/manifest';
import { generateClient, generateClientFiles, type GenerateClientFilesOptions } from '../src/index.js';
import { appBasicManifest } from './support/fixture.js';
import { writeModules, type ModuleDir } from './support/modules.js';
import { typecheckFiles } from './support/typecheck.js';

async function nextFiles(manifest: Manifest, options: Partial<GenerateClientFilesOptions> = {}): Promise<Record<string, string>> {
  const files = await generateClientFiles({ manifest, next: true, ...options });
  return Object.fromEntries(files.map((f) => [f.path, f.contents]));
}

const snapshot = (name: string) => fileURLToPath(new URL(`./__snapshots__/${name}`, import.meta.url));

function matchSnapshot(name: string, contents: string): void {
  if (!existsSync(snapshot(name))) writeFileSync(snapshot(name), contents);
  expect(contents).to.equal(readFileSync(snapshot(name), 'utf8'));
}

function importsOf(contents: string): { from: string; names: string[]; typeOnly: boolean }[] {
  const source = ts.createSourceFile('x.ts', contents, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  return source.statements.flatMap((s) => {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) return [];
    const bindings = s.importClause?.namedBindings;
    const names = bindings && ts.isNamedImports(bindings) ? bindings.elements.map((e) => `${e.isTypeOnly ? 'type ' : ''}${e.name.text}`) : [];
    return [{ from: s.moduleSpecifier.text, names, typeOnly: !!s.importClause?.isTypeOnly }];
  });
}

const typedApp = [
  "import { createNextServerAppClient, nextCacheInit, revalidateController, revalidateRoute, updateController, type NextCacheOptions, type RevalidateProfile } from './client.next.js';",
  "import { createAppClient, type AppClient, type UserDto } from './client.js';",
  '',
  'export async function page(incoming: Headers): Promise<UserDto> {',
  "  const client: AppClient = createNextServerAppClient({ baseUrl: 'http://api', incoming, revalidate: 60 });",
  "  createNextServerAppClient({ baseUrl: 'http://api', revalidate: false, forward: ['cookie', 'origin'], redirect: 'error', init: () => ({ priority: 'high' }) });",
  "  const shared: AppClient = createAppClient({ baseUrl: 'http://api', init: nextCacheInit({ revalidate: 3600 }) });",
  '  const options: NextCacheOptions = {};',
  "  const profile: RevalidateProfile = { expire: 0 };",
  '  void [shared, options, profile];',
  '  return client.users.get(1);',
  '}',
  '',
  'export function afterMutation(): void {',
  "  revalidateController('users');",
  "  revalidateController('articles', { expire: 0 });",
  "  revalidateRoute('users', 'get');",
  "  revalidateRoute('users', 'list', 'hours');",
  "  updateController('users');",
  "  // @ts-expect-error a mutation is never cached, so it has no tag",
  "  revalidateRoute('users', 'create');",
  "  // @ts-expect-error not a controller",
  "  revalidateController('nope');",
  "  // @ts-expect-error createNextServerAppClient is for the server, where credentials mean nothing",
  "  createNextServerAppClient({ baseUrl: 'http://api', credentials: 'include' });",
  '}',
  '',
].join('\n');

interface Route {
  controller: string;
  name: string;
  method: string;
}

type Init = RequestInit & { next?: { tags?: string[]; revalidate?: number | false } };

interface UsersClient {
  users: { get(id: number): Promise<unknown>; list(query: object): Promise<unknown>; create(body: object): Promise<unknown> };
}

interface NextModule {
  nextCacheInit(options?: { revalidate?: number | false }): (route: Route) => Init;
  createNextServerAppClient(options: Record<string, unknown>): UsersClient;
  createAppClient(options: Record<string, unknown>): UsersClient;
  revalidateController(name: string, profile?: unknown): void;
  revalidateRoute(controller: string, route: string, profile?: unknown): void;
  updateController(name: string): void;
  calls: unknown[][];
}

const NEXT_CACHE_STUB = [
  'export const calls = [];',
  "export function revalidateTag(...args) { calls.push(['revalidateTag', ...args]); }",
  "export function updateTag(...args) { calls.push(['updateTag', ...args]); }",
  '',
].join('\n');

describe('Next.js adapter emitter', () => {
  let manifest: Manifest;
  let files: Record<string, string>;

  before(async () => {
    manifest = await appBasicManifest();
    files = await nextFiles(manifest);
  });

  it('matches the committed snapshot of client.next.ts', async () => {
    const named = await nextFiles(manifest, { basename: 'app-basic.client' });
    matchSnapshot('app-basic.client.next.ts', named['app-basic.client.next.ts']);
  });

  it('writes client.keys.ts and client.server.ts with it, all server-safe, and leaves client.ts as 4.0 prints it', async () => {
    const generated = await generateClientFiles({ manifest, next: true });
    expect(generated.map((f) => [f.path, f.environment])).to.deep.equal([
      ['client.ts', 'server-safe'],
      ['client.keys.ts', 'server-safe'],
      ['client.server.ts', 'server-safe'],
      ['client.next.ts', 'server-safe'],
    ]);
    expect(generated[0].contents.replace(`export const manifestHash = '${manifest.hash}';\n\n`, '')).to.equal(await generateClient({ manifest }));
  });

  it('writes the same client.keys.ts and client.server.ts that the hooks and the server target write', async () => {
    const withHooks = await generateClientFiles({ manifest, hooks: ['react-query'], server: true });
    const byPath = Object.fromEntries(withHooks.map((f) => [f.path, f.contents]));
    expect(files['client.keys.ts']).to.equal(byPath['client.keys.ts']);
    expect(files['client.server.ts']).to.equal(byPath['client.server.ts']);
  });

  it("has no 'use client' and takes only revalidateTag and updateTag from next, no Next type", () => {
    expect(files['client.next.ts']).to.not.include('use client');
    expect(importsOf(files['client.next.ts'])).to.deep.equal([
      { from: 'next/cache', names: ['revalidateTag', 'updateTag'], typeOnly: false },
      { from: '@spinajs/client/runtime', names: ['ClientOptions'], typeOnly: true },
      { from: './client.keys.js', names: ['appTags'], typeOnly: false },
      { from: './client.server.js', names: ['createServerAppClient', 'type ServerAppClientOptions'], typeOnly: false },
      { from: './client.js', names: ['AppClient', 'manifestHash'], typeOnly: true },
    ]);
  });

  it('follows basename, moduleName and keyPrefix', async () => {
    const named = await nextFiles(manifest, { basename: 'api', moduleName: './runtime.js', keyPrefix: 'shop' });
    expect(Object.keys(named)).to.deep.equal(['api.ts', 'api.keys.ts', 'api.server.ts', 'api.next.ts']);
    expect(importsOf(named['api.next.ts']).map((i) => i.from)).to.deep.equal(['next/cache', './runtime.js', './api.keys.js', './api.server.js', './api.js']);
    expect(named['api.keys.ts']).to.include("users: { all: 'shop:users'");
  });

  it('type-checks strictly against the next/cache signatures of Next 16', () => {
    expect(typecheckFiles({ ...files, 'app.ts': typedApp }, { noUnusedLocals: true, noUnusedParameters: true })).to.deep.equal([]);
  });

  it('fails to compile against a client.ts generated from another manifest', () => {
    const stale = files['client.ts'].replace(`manifestHash = '${manifest.hash}'`, "manifestHash = 'other'");
    expect(typecheckFiles({ ...files, 'client.ts': stale }).filter((e) => e.startsWith('client.next.ts: '))).to.have.length(1);
  });

  describe('at runtime, with next/cache stubbed', () => {
    let modules: ModuleDir;
    let next: NextModule;
    let seen: { url: string; init: Init }[];

    const fetch = (url: string, init: Init) => {
      seen.push({ url, init });
      return Promise.resolve(Response.json({ id: 1 }));
    };

    before(async () => {
      const index = "export * from './client.next.js';\nexport { createAppClient } from './client.js';\nexport { calls } from './next-cache.js';\n";
      const generated = await nextFiles(manifest, { includeSocket: false });
      modules = writeModules({ ...generated, 'next-cache.js': NEXT_CACHE_STUB, 'index.js': index }, { 'next/cache': './next-cache.js', '@spinajs/client/runtime': import.meta.resolve('@spinajs/client/runtime') });
      next = await modules.import<NextModule>('index.js');
    });

    after(() => modules.remove());

    beforeEach(() => {
      seen = [];
      next.calls.length = 0;
    });

    it('tags GET query routes only, with spinajs:<controller> and spinajs:<controller>:<handler>', () => {
      const init = next.nextCacheInit({ revalidate: 60 });
      expect(init({ controller: 'users', name: 'get', method: 'get' })).to.deep.equal({ next: { tags: ['spinajs:users', 'spinajs:users:get'], revalidate: 60 } });
      expect(init({ controller: 'health', name: 'get', method: 'get' })).to.deep.equal({ next: { tags: ['spinajs:health', 'spinajs:health:get'], revalidate: 60 } });
      expect(init({ controller: 'users', name: 'create', method: 'post' })).to.deep.equal({});
      expect(init({ controller: 'users', name: 'avatar', method: 'post' })).to.deep.equal({});
      expect(init({ controller: 'users', name: 'get', method: 'delete' })).to.deep.equal({});
      expect(init({ controller: 'nope', name: 'get', method: 'get' })).to.deep.equal({});
      expect(init({ controller: 'users', name: 'toString', method: 'get' })).to.deep.equal({});
    });

    it('leaves revalidate to Next when it is not given, and passes false through', () => {
      expect(next.nextCacheInit()({ controller: 'users', name: 'get', method: 'get' })).to.deep.equal({ next: { tags: ['spinajs:users', 'spinajs:users:get'] } });
      expect(next.nextCacheInit({ revalidate: false })({ controller: 'users', name: 'get', method: 'get' })).to.deep.equal({ next: { tags: ['spinajs:users', 'spinajs:users:get'], revalidate: false } });
    });

    it('reaches fetch through createAppClient, for GET only', async () => {
      const client = next.createAppClient({ baseUrl: 'http://api', fetch, init: next.nextCacheInit({ revalidate: 60 }) });
      await client.users.get(1);
      await client.users.create({ email: 'a@b' });
      expect(seen.map((s) => [s.init.method, s.init.next])).to.deep.equal([
        ['GET', { tags: ['spinajs:users', 'spinajs:users:get'], revalidate: 60 }],
        ['POST', undefined],
      ]);
    });

    it("revalidateController('users') calls revalidateTag('spinajs:users', 'max')", () => {
      next.revalidateController('users');
      next.revalidateController('articles', { expire: 0 });
      expect(next.calls).to.deep.equal([
        ['revalidateTag', 'spinajs:users', 'max'],
        ['revalidateTag', 'spinajs:articles', { expire: 0 }],
      ]);
    });

    it('revalidateRoute revalidates one route tag, and updateController calls updateTag', () => {
      next.revalidateRoute('users', 'get');
      next.revalidateRoute('users', 'list', 'hours');
      next.updateController('users');
      expect(next.calls).to.deep.equal([
        ['revalidateTag', 'spinajs:users:get', 'max'],
        ['revalidateTag', 'spinajs:users:list', 'hours'],
        ['updateTag', 'spinajs:users'],
      ]);
    });

    describe('createNextServerAppClient', () => {
      const get = async (options: Record<string, unknown>) => {
        await next.createNextServerAppClient({ baseUrl: 'http://api', fetch, revalidate: 60, ...options }).users.get(1);
        return seen[seen.length - 1].init;
      };

      it('tags and caches a GET that carries no user credentials', async () => {
        const init = await get({ incoming: new Headers({ 'accept-language': 'pl' }) });
        expect(init.next).to.deep.equal({ tags: ['spinajs:users', 'spinajs:users:get'], revalidate: 60 });
        expect(init).to.not.have.property('cache');
      });

      it("never caches a call with a forwarded cookie or authorization: no tags or revalidate, cache: 'no-store'", async () => {
        for (const incoming of [new Headers({ cookie: 'session=abc' }), { authorization: 'Bearer t' }]) {
          const init = await get({ incoming });
          expect(init.cache).to.equal('no-store');
          expect(init).to.not.have.property('next');
          expect(init.headers).to.satisfy((h: Record<string, string>) => 'cookie' in h || 'authorization' in h);
        }
      });

      it('treats credentials the app adds itself the same way, in any case', async () => {
        const init = await get({ headers: { Authorization: 'Bearer service' } });
        expect(init.cache).to.equal('no-store');
        expect(init).to.not.have.property('next');
      });

      it('never tags a mutation', async () => {
        await next.createNextServerAppClient({ baseUrl: 'http://api', fetch, revalidate: 60 }).users.create({ email: 'a@b' });
        expect(seen[0].init).to.not.have.property('next');
        expect(seen[0].init).to.not.have.property('cache');
      });

      it("keeps the app's own init, its fetch and redirect", async () => {
        const counted: string[] = [];
        const own = (url: string, init: Init) => (counted.push(url), fetch(url, init));
        const init = await get({ fetch: own, redirect: 'error', init: () => ({ priority: 'high' }) });
        expect(counted).to.deep.equal(['http://api/users/1']);
        expect(init).to.include({ priority: 'high', redirect: 'error' });
        expect(init.next).to.deep.equal({ tags: ['spinajs:users', 'spinajs:users:get'], revalidate: 60 });
      });

      it('looks up globalThis.fetch per call, which Next patches, when no fetch is given', async () => {
        const original = globalThis.fetch;
        globalThis.fetch = fetch as typeof globalThis.fetch;
        try {
          await next.createNextServerAppClient({ baseUrl: 'http://api' }).users.get(1);
        } finally {
          globalThis.fetch = original;
        }
        expect(seen.map((s) => s.url)).to.deep.equal(['http://api/users/1']);
      });
    });
  });
});
