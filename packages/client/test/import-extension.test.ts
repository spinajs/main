import 'mocha';
import { expect } from 'chai';
import type { Manifest } from '@spinajs/manifest';
import { generateClientFiles, type GenerateClientFilesOptions } from '../src/index.js';
import { appBasicManifest } from './support/fixture.js';
import { typecheckFiles } from './support/typecheck.js';

const EVERY_TARGET: Partial<GenerateClientFilesOptions> = { zod: true, hooks: ['react-query', 'swr'], socketHooks: true, models: true, server: true, next: true, mocks: true, msw: true };
const TYPED: Partial<GenerateClientFilesOptions> = { zod: true, hooks: ['react-query'], server: true, next: true };

const siblingImports = (contents: string): string[] => [...contents.matchAll(/from '(\.\/[^']+)'/g)].map((m) => m[1]);

describe('generateClientFiles: how the generated files import each other', function () {
  this.timeout(120000);

  let manifest: Manifest;

  before(async () => {
    manifest = await appBasicManifest();
  });

  const files = async (options: Partial<GenerateClientFilesOptions>, targets = EVERY_TARGET) => generateClientFiles({ manifest, ...targets, ...options });

  const cases: [Partial<GenerateClientFilesOptions>, string, string][] = [
    [{}, '.ts', '.js'],
    [{ importExtension: 'ts' }, '.ts', '.ts'],
    [{ importExtension: 'none' }, '.ts', ''],
    [{ fileExtension: '.mts' }, '.mts', '.mjs'],
    [{ fileExtension: '.mts', importExtension: 'ts' }, '.mts', '.mts'],
    [{ fileExtension: '.mts', importExtension: 'none' }, '.mts', ''],
  ];

  for (const [options, fileExtension, importExtension] of cases) {
    it(`${JSON.stringify(options)}: every file ends in ${fileExtension} and imports a generated sibling as '<name>${importExtension}'`, async () => {
      const generated = await files(options);
      const names = new Set(generated.map((f) => f.path.slice(0, -fileExtension.length)));
      for (const file of generated) {
        expect(file.path.endsWith(fileExtension), file.path).to.equal(true);
        for (const specifier of siblingImports(file.contents)) {
          expect(specifier.endsWith(importExtension), `${file.path} imports ${specifier}`).to.equal(true);
          expect(names.has(specifier.slice(2, specifier.length - importExtension.length)), `${file.path} imports ${specifier}`).to.equal(true);
        }
      }
    });
  }

  it('writes the same files as before when nothing is set', async () => {
    expect(await files({ importExtension: 'js', fileExtension: '.ts' })).to.deep.equal(await files({}));
  });

  const contentsOf = async (options: Partial<GenerateClientFilesOptions>) => Object.fromEntries((await files(options, TYPED)).map((f) => [f.path, f.contents]));

  it('compiles extensionless imports with bundler resolution', async () => {
    expect(typecheckFiles(await contentsOf({ importExtension: 'none' }), { resolution: 'bundler' })).to.deep.equal([]);
  });

  it('compiles .mts files that import .mjs with node16 resolution', async () => {
    expect(typecheckFiles(await contentsOf({ fileExtension: '.mts' }))).to.deep.equal([]);
  });

  // `.mts` reserves `<T>(` for a future syntax, so the generic arrow helpers of the swr and React Query hooks change there.
  it('compiles every target as .mts files', async () => {
    const generated = await files({ fileExtension: '.mts' });
    expect(typecheckFiles(Object.fromEntries(generated.map((f) => [f.path, f.contents])))).to.deep.equal([]);
  });

  it('compiles .ts imports with allowImportingTsExtensions', async () => {
    expect(typecheckFiles(await contentsOf({ importExtension: 'ts' }), { allowImportingTsExtensions: true })).to.deep.equal([]);
  });
});
