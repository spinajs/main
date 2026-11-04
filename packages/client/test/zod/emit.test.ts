import 'mocha';
import { expect } from 'chai';
import { fileURLToPath } from 'node:url';
import { analyzePackage } from '@spinajs/compiler';
import { mergeFragments, type Manifest } from '@spinajs/manifest';
import { buildClientModel, emitZod, generateClient, generateClientFiles, type GeneratedFile } from '../../src/index.js';
import { appBasicManifest } from '../support/fixture.js';
import { matchesSnapshot as compareSnapshot } from '../support/snapshot.js';
import { typecheckFiles } from '../support/typecheck.js';
import { clearLoaded, loadZod, manifestWith, param, route, schemaIn } from '../support/zod.js';

// Each fixture's pair of files sits in its own folder, so the snapshot's `./client.js` import resolves for tsc and ESLint.
const snapshot = (name: string) => fileURLToPath(new URL(`../__snapshots__/zod/${name}`, import.meta.url));
const corpusRoot = fileURLToPath(new URL('../fixtures/schema-corpus', import.meta.url));

async function corpusManifest(): Promise<Manifest> {
  const fragment = await analyzePackage({ tsconfig: `${corpusRoot}/tsconfig.json`, packageRoot: corpusRoot });
  return mergeFragments(fragment, [], { app: { name: 'schema-corpus', version: '0.1.0', root: '.', outDir: 'lib' }, packages: [], generatedAt: '' });
}

const matchesSnapshot = (name: string, contents: string): void => compareSnapshot(snapshot(name), contents);

const byPath = (files: GeneratedFile[]): Record<string, string> => Object.fromEntries(files.map((f) => [f.path, f.contents]));

describe('client.zod.ts', function () {
  this.timeout(120000);

  after(clearLoaded);

  for (const [fixture, load] of [
    ['app-basic', appBasicManifest],
    ['schema-corpus', corpusManifest],
  ] as const) {
    describe(fixture, () => {
      let manifest: Manifest;
      let files: GeneratedFile[];

      before(async () => {
        manifest = await load();
        files = await generateClientFiles({ manifest, zod: true });
      });

      it('matches the committed snapshots', () => {
        expect(files.map((f) => f.path)).to.deep.equal(['client.ts', 'client.zod.ts']);
        for (const file of files) matchesSnapshot(`${fixture}/${file.path}`, file.contents);
      });

      for (const mini of [false, true]) {
        it(`type-checks with client.ts, every satisfies included (${mini ? 'zod/mini' : 'zod'})`, async () => {
          const pair = mini ? await generateClientFiles({ manifest, zod: { mini: true } }) : files;
          expect(typecheckFiles(byPath(pair), { noUnusedLocals: true })).to.deep.equal([]);
        });
      }

      it('is deterministic and LF only', async () => {
        expect(emitZod(buildClientModel(manifest), {}).contents).to.equal(files[1].contents);
        expect(byPath(await generateClientFiles({ manifest, zod: true }))).to.deep.equal(byPath(files));
        expect(files[1].contents).to.not.include('\r');
      });
    });
  }

  it('leaves client.ts as it is without zod, and adds only the manifestHash export with it', async () => {
    const manifest = await appBasicManifest();
    const client = await generateClient({ manifest });
    const [withZod] = await generateClientFiles({ manifest, zod: true });
    expect(withZod.contents.replace(`export const manifestHash = '${manifest.hash}';\n\n`, '')).to.equal(client);
    expect(await generateClientFiles({ manifest })).to.deep.equal([{ path: 'client.ts', contents: client }]);
  });

  it('names the file after basename and imports the types from it', async () => {
    const files = await generateClientFiles({ manifest: await appBasicManifest(), basename: 'api', zod: { mini: true } });
    expect(files.map((f) => f.path)).to.deep.equal(['api.ts', 'api.zod.ts']);
    expect(files[1].contents).to.include("import { z } from 'zod/mini';");
    expect(files[1].contents).to.match(/import type \{ [^}]*manifestHash \} from '\.\/api\.js';/);
  });

  it('attaches the diagnostics to the zod file', async () => {
    const [, zod] = await generateClientFiles({ manifest: await corpusManifest(), zod: { unsupported: 'error' } });
    expect(zod.diagnostics?.map((d) => [d.code, d.severity, d.schema, d.pointer])).to.deep.equal([['ZOD002', 'error', 'spinajs/schema-corpus/SignUpDto', '/properties/zip/format']]);
  });

  it('declares a bounded array item once, not once per tuple slot', async () => {
    const item = { type: 'object', properties: { sku: { type: 'string', minLength: 1 }, qty: { type: 'integer', minimum: 1 } }, required: ['sku', 'qty'], additionalProperties: false };
    const manifest = manifestWith(await appBasicManifest(), { Order: { type: 'object', properties: { lines: { type: 'array', items: item, maxItems: 20 } }, additionalProperties: false } });
    const { contents } = emitZod(buildClientModel(manifest), {});
    expect(contents.split('z.strictObject(').length - 1).to.equal(2);
    expect(contents.length).to.be.below(4000);
    const order = schemaIn(await loadZod(contents), 'OrderSchema');
    const lines = (n: number) => Array.from({ length: n }, () => ({ sku: 'a', qty: 1 }));
    expect([0, 1, 20].map((n) => order.safeParse({ lines: lines(n) }).success)).to.deep.equal([true, true, true]);
    expect(order.safeParse({ lines: lines(21) }).success).to.equal(false);
    expect(order.safeParse({ lines: [{ sku: '', qty: 1 }] }).success).to.equal(false);
  });

  describe('routeSchemas', () => {
    let module: Record<string, unknown>;
    let contents: string;

    before(async () => {
      const closed = { type: 'object', properties: { a: { type: 'string' }, inner: { type: 'object', properties: { b: { type: 'number' } }, additionalProperties: false } }, required: ['a'], additionalProperties: false };
      const routes = [
        route('whole', 'post', [param(0, 'body', 'FromBody', { in: 'body', shape: 'whole' }, 'test/Dto', 'Dto')]),
        route('fields', 'post', [param(0, 'title', 'FromBody', { in: 'body', name: 'title', shape: 'field' }, 'test/Dto', 'Dto'), param(1, 'n', 'FromBody', { in: 'body', name: 'n', shape: 'field' }, 'test/N')]),
        route('wholeQuery', 'get', [param(0, 'filter', 'QueryFieldRouteArgs', { in: 'query', shape: 'whole' }, 'test/Dto', 'Dto'), param(1, 'q', 'FromQuery', { in: 'query', name: 'q', shape: 'json' }, 'test/Dto', 'Dto')]),
        route('upload', 'post', [param(0, 'file', 'FromFile', { in: 'multipart', name: 'file', shape: 'value' }), param(1, 'm', 'FromModel', { in: 'path', name: 'm', shape: 'value' }, 'test/N')]),
        route('raw', 'post', [param(0, 'raw', 'RawBodyRouteArgs', { in: 'body', shape: 'whole' }, 'test/N')]),
        route('either', 'post', [param(0, 'body', 'FromBody', { in: 'body', shape: 'whole' }, 'test/Either', 'Either')]),
      ];
      const manifest = manifestWith(await appBasicManifest(), {}, { 'test/Dto': closed, 'test/N': { type: 'integer', minimum: 1 }, 'test/Either': { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false, anyOf: [{ required: ['a'] }, { required: ['b'] }] } }, routes);
      contents = emitZod(buildClientModel(manifest), {}).contents;
      module = await loadZod(contents);
    });

    const at = (handler: string, arg: string) => schemaIn((module.routeSchemas as Record<string, Record<string, Record<string, unknown>>>).items[handler], arg);

    it('opens a whole body root and drops undeclared keys, as the server does; nested objects stay closed', () => {
      expect(contents).to.include('body: /*#__PURE__*/ z.object(DtoSchema.shape),');
      expect(at('whole', 'body').safeParse({ a: 'x', reauthPassword: 'p' })).to.deep.equal({ success: true, data: { a: 'x' } });
      expect(at('whole', 'body').safeParse({ a: 'x', inner: { b: 1, c: 2 } }).success).to.equal(false);
    });

    it('keeps a body field and a single query value closed', () => {
      expect(at('fields', 'title').safeParse({ a: 'x', c: 1 }).success).to.equal(false);
      expect(at('wholeQuery', 'q').safeParse({ a: 'x', c: 1 }).success).to.equal(false);
      expect(contents).to.include('n: /*#__PURE__*/ z.number().refine(Number.isInteger');
    });

    it('opens a whole query root and keeps the other keys, which other arguments read', () => {
      expect(contents).to.include('filter: /*#__PURE__*/ z.looseObject(DtoSchema.shape),');
      expect(at('wholeQuery', 'filter').safeParse({ a: 'x', q: '{}' })).to.deep.equal({ success: true, data: { a: 'x', q: '{}' } });
    });

    it('keeps the undeclared keys of an opened root whose checks read them', () => {
      expect(at('either', 'body').safeParse({ b: {} }).success).to.equal(true);
      expect(at('either', 'body').safeParse({ c: 1 }).success).to.equal(false);
    });

    it('leaves out the arguments the server does not validate: files, models, raw bodies', () => {
      expect(contents).to.not.include('upload:');
      expect(contents).to.not.include('raw:');
    });
  });
});
