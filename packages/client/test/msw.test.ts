import 'mocha';
import { expect } from 'chai';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { Manifest } from '@spinajs/manifest';
import { buildClientModel, emitMsw, generateClientFiles, type GeneratedFile } from '../src/index.js';
import { appBasicManifest, corpusManifest } from './support/fixture.js';
import { clearGenerated, loadGenerated } from './support/msw.js';
import { serverCheck } from './support/mocks.js';
import { typecheckFiles } from './support/typecheck.js';
import { manifestWith, route } from './support/zod.js';

// The mocks snapshots already hold client.ts and client.mocks.ts, which client.msw.ts imports.
const snapshot = (name: string) => fileURLToPath(new URL(`./__snapshots__/mocks/${name}`, import.meta.url));

function matchesSnapshot(name: string, contents: string): void {
  const path = snapshot(name);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  expect(contents).to.equal(readFileSync(path, 'utf8'));
}

const byPath = (files: GeneratedFile[]): Record<string, string> => Object.fromEntries(files.map((f) => [f.path, f.contents]));
const server = setupServer();

describe('client.msw.ts', function () {
  this.timeout(120000);

  before(() => server.listen({ onUnhandledFrame: 'bypass' }));
  afterEach(() => server.resetHandlers());
  after(() => {
    server.close();
    clearGenerated();
  });

  for (const [fixture, load] of [
    ['app-basic', appBasicManifest],
    ['schema-corpus', corpusManifest],
  ] as const) {
    describe(fixture, () => {
      let files: GeneratedFile[];

      before(async () => {
        files = await generateClientFiles({ manifest: await load(), mocks: true, msw: true });
      });

      it('matches the committed snapshot', () => {
        expect(files.map((f) => f.path)).to.deep.equal(['client.ts', 'client.mocks.ts', 'client.msw.ts']);
        matchesSnapshot(`${fixture}/client.ts`, files[0].contents);
        matchesSnapshot(`${fixture}/client.mocks.ts`, files[1].contents);
        matchesSnapshot(`${fixture}/client.msw.ts`, files[2].contents);
      });

      it('type-checks with client.ts and client.mocks.ts', () => {
        expect(typecheckFiles(byPath(files), { noUnusedLocals: true })).to.deep.equal([]);
      });

      it('is server-safe: no directive, no React, and msw only here', () => {
        const [client, mocks, msw] = files.map((f) => f.contents);
        expect(msw).to.not.match(/^\s*['"]use client['"]/m);
        expect(msw).to.not.match(/from ['"]react/);
        expect(msw).to.match(/from 'msw';/);
        for (const other of [client, mocks]) expect(other).to.not.match(/from ['"]msw/);
      });

      it('is deterministic and LF only', async () => {
        expect(emitMsw(buildClientModel(await load())).contents).to.equal(files[2].contents);
        expect(files[2].contents).to.not.include('\r');
      });
    });
  }

  it('names the file after basename', async () => {
    const files = await generateClientFiles({ manifest: await appBasicManifest(), basename: 'api', mocks: true, msw: true });
    expect(files.map((f) => f.path)).to.deep.equal(['api.ts', 'api.mocks.ts', 'api.msw.ts']);
    expect(files[2].contents).to.include("from './api.js';").and.to.include("from './api.mocks.js';");
    expect(typecheckFiles(byPath(files))).to.deep.equal([]);
  });

  describe('overrides are typed per route', () => {
    let files: GeneratedFile[];

    before(async () => {
      files = await generateClientFiles({ manifest: await appBasicManifest(), mocks: true, msw: true });
    });

    const check = (usage: string) => typecheckFiles({ ...byPath(files), 'usage.ts': `import { HttpResponse } from 'msw';\nimport { createAppHandlers } from './client.msw.js';\n${usage}\n` });

    it('accepts a resolver that replies with the route type, and a void route that replies 204', () => {
      expect(check("createAppHandlers('http://x', { users: { get: () => HttpResponse.json({ id: 1, email: 'a@b.c' }), avatar: () => new HttpResponse(null, { status: 204 }) } });")).to.deep.equal([]);
    });

    it('fails tsc on a reply of the wrong type', () => {
      const errors = check("createAppHandlers('http://x', { users: { get: () => HttpResponse.json({ wrong: true }) } });");
      expect(errors).to.have.length.greaterThan(0);
      expect(errors.join('\n')).to.match(/usage\.ts/);
    });

    it('fails tsc on an override for a route the client does not have', () => {
      expect(check("createAppHandlers('http://x', { users: { nothing: () => HttpResponse.json({}) } });")).to.have.length.greaterThan(0);
    });
  });

  describe('against MSW setupServer (app-basic)', () => {
    const baseUrl = 'http://127.0.0.1:59321';
    let manifest: Manifest;
    let loaded: Awaited<ReturnType<typeof loadGenerated>>;
    let client: ReturnType<typeof loaded.createAppClient>;

    before(async () => {
      manifest = await appBasicManifest();
      loaded = await loadGenerated(await generateClientFiles({ manifest, mocks: true, msw: true }));
      client = loaded.createAppClient({ baseUrl });
    });

    beforeEach(() => server.use(...loaded.createAppHandlers(baseUrl)));

    it('answers every GET route of the manifest with data that passes the reply schema', async () => {
      const check = serverCheck(manifest);
      const gets = buildClientModel(manifest).controllers.flatMap((c) => c.routes.filter((r) => r.method === 'get').map((r) => ({ c, r })));
      expect(gets.length).to.be.greaterThan(0);
      for (const { c, r } of gets) {
        const args = r.args.map((a) => (a.type === 'number' ? 1 : a.name === 'query' ? {} : 'x'));
        const reply = await client[c.key][r.name](...args);
        const label = `${c.key}.${r.name}`;
        if (r.returnSchema !== undefined) expect(check(r.returnSchema, reply), label).to.equal(undefined);
        else if (r.returns === 'UserDto[]') for (const item of reply as unknown[]) expect(check('spinajs/app-basic/UserDto', item), label).to.equal(undefined);
        else expect(reply, label).to.have.property('ok').that.is.a('boolean');
      }
    });

    it('answers a mutation with mock data', async () => {
      const reply = await client.articles.add({ title: 'x' });
      expect(serverCheck(manifest)('spinajs/app-basic/ArticleDto', reply)).to.equal(undefined);
    });

    it('answers a void route with 204 and no body', async () => {
      expect(await client.users.avatar(1, new Blob(['x']))).to.equal(undefined);
      const response = await fetch(`${baseUrl}/users/1/avatar`, { method: 'POST' });
      expect(response.status).to.equal(204);
      expect(await response.text()).to.equal('');
    });

    it('replaces one route with an override and leaves the others', async () => {
      server.use(...loaded.createAppHandlers(baseUrl, { users: { get: ({ params }: { params: { id: string } }) => HttpResponse.json({ id: Number(params.id), email: 'override@example.com' }) } }));
      expect(await client.users.get(7)).to.deep.equal({ id: 7, email: 'override@example.com' });
      expect(serverCheck(manifest)('spinajs/app-basic/ArticleDto', await client.articles.read(3))).to.equal(undefined);
    });

    it('is deterministic: the same route answers the same data', async () => {
      expect(await client.users.get(1)).to.deep.equal(await client.users.get(1));
    });

    it('tolerates a trailing slash on the base URL', async () => {
      server.resetHandlers(...loaded.createAppHandlers(`${baseUrl}/`));
      expect(await client.health.get()).to.have.property('ok');
    });
  });

  describe('Express 5 paths against MSW setupServer', () => {
    const baseUrl = 'http://127.0.0.1:59321/api';
    let loaded: Awaited<ReturnType<typeof loadGenerated>>;
    let client: ReturnType<typeof loaded.createAppClient>;

    before(async () => {
      const make = (handler: string, fullPath: string) => ({ ...route(handler, 'get', []), fullPath, returnType: { text: 'string' } });
      const manifest = manifestWith(await appBasicManifest(), {}, {}, [make('optional', '/items/optional{/:id}'), make('twice', '/items/twice{/:a}{/:b}'), make('wild', '/items/wild/*path')]);
      loaded = await loadGenerated(await generateClientFiles({ manifest, mocks: true, msw: true }));
      client = loaded.createAppClient({ baseUrl });
    });

    beforeEach(() => server.use(...loaded.createAppHandlers(baseUrl)));

    const status = async (path: string) => {
      try {
        return (await fetch(`${baseUrl}${path}`)).status;
      } catch {
        return 'no handler';
      }
    };

    it('matches a route with an optional group with and without the segment', async () => {
      expect(await client.items.optional()).to.be.a('string');
      expect(await client.items.optional(5)).to.be.a('string');
      expect(await status('/items/optional')).to.equal(200);
      expect(await status('/items/optional/5')).to.equal(200);
      expect(await status('/items/optional/5/6')).to.equal('no handler');
    });

    it('matches every combination of two optional groups', async () => {
      for (const path of ['/items/twice', '/items/twice/1', '/items/twice/1/2']) expect(await status(path), path).to.equal(200);
    });

    it('matches a wildcard against one or more segments', async () => {
      expect(await status('/items/wild/a')).to.equal(200);
      expect(await status('/items/wild/a/b/c')).to.equal(200);
      expect(await status('/items/wild')).to.equal('no handler');
    });

    it('passes an override the parameters MSW read', async () => {
      const seen: unknown[] = [];
      server.use(
        ...loaded.createAppHandlers(baseUrl, {
          items: {
            optional: ({ params }: { params: unknown }) => {
              seen.push(params);
              return HttpResponse.json('seen');
            },
          },
        }),
      );
      await client.items.optional();
      await client.items.optional(5);
      expect(seen).to.deep.equal([{}, { id: '5' }]);
    });
  });
});
