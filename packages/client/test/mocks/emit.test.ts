import 'mocha';
import { expect } from 'chai';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Manifest } from '@spinajs/manifest';
import { buildClientModel, emitMocks, generateClient, generateClientFiles, GENERATOR_TARGETS, type GeneratedFile, type GenerateClientFilesOptions, type GeneratorTarget } from '../../src/index.js';
import { appBasicManifest, corpusManifest } from '../support/fixture.js';
import { clearMocks, loadMocks, mockFunction, serverCheck } from '../support/mocks.js';
import { typecheckFiles } from '../support/typecheck.js';
import { manifestWith } from '../support/zod.js';

const snapshot = (name: string) => fileURLToPath(new URL(`../__snapshots__/mocks/${name}`, import.meta.url));
const sourceDir = fileURLToPath(new URL('../../src/', import.meta.url));

function matchesSnapshot(name: string, contents: string): void {
  const path = snapshot(name);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  expect(contents).to.equal(readFileSync(path, 'utf8'));
}

const byPath = (files: GeneratedFile[]): Record<string, string> => Object.fromEntries(files.map((f) => [f.path, f.contents]));

/** Module specifiers of every static and dynamic import and re-export in TypeScript source. */
function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []));
}

describe('client.mocks.ts', function () {
  this.timeout(120000);

  after(clearMocks);

  for (const [fixture, load] of [
    ['app-basic', appBasicManifest],
    ['schema-corpus', corpusManifest],
  ] as const) {
    describe(fixture, () => {
      let manifest: Manifest;
      let files: GeneratedFile[];

      before(async () => {
        manifest = await load();
        files = await generateClientFiles({ manifest, mocks: true });
      });

      it('matches the committed snapshots', () => {
        expect(files.map((f) => f.path)).to.deep.equal(['client.ts', 'client.mocks.ts']);
        for (const file of files) matchesSnapshot(`${fixture}/${file.path}`, file.contents);
        expect(files[1].diagnostics).to.deep.equal([]);
      });

      it('type-checks with client.ts', () => {
        expect(typecheckFiles(byPath(files), { noUnusedLocals: true })).to.deep.equal([]);
      });

      it('is deterministic and LF only', async () => {
        expect(emitMocks(buildClientModel(manifest)).contents).to.equal(files[1].contents);
        expect(byPath(await generateClientFiles({ manifest, mocks: true }))).to.deep.equal(byPath(files));
        expect(files[1].contents).to.not.include('\r');
      });
    });
  }

  it('leaves client.ts as it is without mocks, and adds only the manifestHash export with it', async () => {
    const manifest = await appBasicManifest();
    const client = await generateClient({ manifest });
    const [withMocks] = await generateClientFiles({ manifest, mocks: true });
    expect(withMocks.contents.replace(`export const manifestHash = '${manifest.hash}';\n\n`, '')).to.equal(client);
    expect(await generateClientFiles({ manifest, mocks: false })).to.deep.equal([{ path: 'client.ts', contents: client }]);
  });

  it('names the file after basename and imports the types from it', async () => {
    const files = await generateClientFiles({ manifest: await appBasicManifest(), basename: 'api', mocks: true });
    expect(files.map((f) => f.path)).to.deep.equal(['api.ts', 'api.mocks.ts']);
    expect(files[1].contents).to.include("from './api.js';");
    expect(typecheckFiles(byPath(files))).to.deep.equal([]);
  });

  it('is a leaf: no generated file imports client.mocks.ts or client.msw.ts, and runtime/ and formats/ never import mocks/', async () => {
    // Every target that writes a file of its own; the next emitter that lands joins this list.
    const writing = (Object.keys(GENERATOR_TARGETS) as GeneratorTarget[]).filter((t) => GENERATOR_TARGETS[t].available);
    expect(writing).to.deep.equal(['zod', 'mocks']);
    const options: GenerateClientFilesOptions = { manifest: await appBasicManifest(), zod: true, mocks: true };
    for (const basename of ['client', 'api']) {
      const files = await generateClientFiles({ ...options, basename });
      expect(files.map((f) => f.path)).to.include(`${basename}.mocks.ts`);
      for (const file of files) {
        expect(importsOf(file.contents).filter((s) => /\.(mocks|msw)(\.js|\.ts)?$/.test(s)), file.path).to.deep.equal([]);
      }
      expect(importsOf(files.find((f) => f.path === `${basename}.mocks.ts`)!.contents).filter((s) => s === 'msw' || s.startsWith('msw/'))).to.deep.equal([]);
    }
    for (const file of [...sources(join(sourceDir, 'runtime')), ...sources(join(sourceDir, 'formats'))]) {
      expect(importsOf(readFileSync(file, 'utf8')).filter((s) => /mocks/.test(s)), file).to.deep.equal([]);
    }
  });

  it('reports MOCK001 for each schema whose mock throws, and names the keyword', async () => {
    const manifest = manifestWith(await appBasicManifest(), {
      Plain: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      Guarded: { type: 'string', not: { const: '' } },
      Holder: { type: 'object', properties: { g: { $ref: 'test/Guarded' } }, required: ['g'] },
    });
    const [, file] = await generateClientFiles({ manifest, mocks: true });
    expect(file.diagnostics?.map(({ code, severity, schema, pointer }) => ({ code, severity, schema, pointer }))).to.deep.equal([
      { code: 'MOCK001', severity: 'warning', schema: 'test/Guarded', pointer: '/not' },
      { code: 'MOCK001', severity: 'warning', schema: 'test/Holder', pointer: '/properties/g/$ref' },
    ]);
    expect(file.diagnostics?.[0].message).to.equal('mockGuarded() throws MockUnsupported: keyword not is not supported by the mock sampler');
    const module = await loadMocks(file.contents);
    expect(() => mockFunction(module, 'Guarded')()).to.throw(/MOCK001/);
    expect(() => mockFunction(module, 'Holder')()).to.throw(/MOCK001/);
    expect(mockFunction(module, 'Plain')()).to.have.property('a').that.is.a('string');
  });

  it('keeps a DTO named Page as mockPage and drops that page helper from the re-export', async () => {
    const manifest = manifestWith(await appBasicManifest(), { Page: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] } });
    const [, file] = await generateClientFiles({ manifest, mocks: true });
    expect(file.contents).to.include('export function mockPage(');
    expect(file.contents).to.include("export { mockCursorPage } from '@spinajs/client/mocks';");
  });

  describe('createMockAppClient (app-basic)', () => {
    let manifest: Manifest;
    let module: Awaited<ReturnType<typeof loadMocks>>;

    before(async () => {
      manifest = await appBasicManifest();
      const [, file] = await generateClientFiles({ manifest, mocks: true });
      module = await loadMocks(file.contents);
    });

    it('calls an implemented method with its arguments', async () => {
      const calls: unknown[] = [];
      const client = module.createMockAppClient({ users: { get: (id: number) => (calls.push(id), Promise.resolve({ id, email: 'a@b.co' })) } });
      expect(await client.users.get(7)).to.deep.equal({ id: 7, email: 'a@b.co' });
      expect(calls).to.deep.equal([7]);
    });

    it('rejects an unimplemented method with MockNotImplemented naming users.get', async () => {
      const error = await module.createMockAppClient({}).users.get(1).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(error?.name).to.equal('MockNotImplemented');
      expect(error?.message).to.equal('createMockAppClient: users.get is not implemented; pass it in the first argument');
    });

    it("resolves to data that passes the reply schema under fallback: 'mock'", async () => {
      const check = serverCheck(manifest);
      const client = module.createMockAppClient({}, { fallback: 'mock', seed: 4 });
      const user = await client.users.get(1);
      expect(check('spinajs/app-basic/UserDto', user)).to.equal(undefined);
      expect(user).to.deep.equal(mockFunction(module, 'UserDto')(undefined, { seed: 4 }));
      expect(await client.users.avatar(1, new Blob())).to.equal(undefined);
    });
  });
});
