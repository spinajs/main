import 'mocha';
import { expect } from 'chai';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Diagnostic, Manifest, ManifestFragment } from '@spinajs/manifest';
import { analyzePackage, buildAppManifest, type EffectiveDirs } from '../src/index.js';

const ROOT = resolve('test/fixtures/app-dirs');
const built = (...dirs: string[]): string[] => dirs.map((d) => join(ROOT, 'lib', d));
const PACKAGE_DIR = join(ROOT, 'node_modules', '@spinajs', 'http', 'lib', 'controllers');

const DIRS = {
  controllers: [PACKAGE_DIR, ...built('controllers')],
  socketControllers: built('sockets'),
  schedules: built('schedules'),
  cli: built('commands'),
  migrations: built('migrations'),
};

const analyze = (effectiveDirs?: EffectiveDirs, tsconfig = 'tsconfig.json'): Promise<ManifestFragment> =>
  analyzePackage({ tsconfig: join(ROOT, tsconfig), packageRoot: ROOT, schemaDerivation: false, effectiveDirs });

const names = (entries: Array<{ className: string }>): string[] => entries.map((e) => e.className).sort();
const withCode = (diagnostics: Diagnostic[], code: string): Diagnostic[] => diagnostics.filter((d) => d.code === code);
const about = (diagnostics: Diagnostic[], className: string): Diagnostic | undefined => diagnostics.find((d) => d.message.includes(className));

describe("an app's classes against its effective dirs", function () {
  this.timeout(60_000);

  it('filters nothing without the data, as a direct call of the analyzer always did', async () => {
    const fragment = await analyze();
    expect(names(fragment.controllers)).to.include.members(['ElsewhereController', 'ShopController', 'OldController']);
    expect([...withCode(fragment.diagnostics, 'CMP006'), ...withCode(fragment.diagnostics, 'CMP007')]).to.deep.equal([]);
  });

  describe('a class outside every dir of its section', () => {
    let fragment: ManifestFragment;

    before(async () => {
      fragment = await analyze(DIRS);
    });

    const SECTIONS: Array<[string, () => Array<{ className: string }>, string, string, string]> = [
      ['controllers', () => fragment.controllers, 'KeptController', 'ElsewhereController', 'src/controllers'],
      ['socket controllers', () => fragment.socketControllers, 'KeptSocket', 'ElsewhereSocket', 'src/sockets'],
      ['schedules', () => fragment.schedules, 'KeptTask', 'ElsewhereTask', 'src/schedules'],
      ['commands', () => fragment.commands, 'KeptCommand', 'ElsewhereCommand', 'src/commands'],
      ['migrations', () => fragment.migrations, 'Kept_2026_01_01_00_00_00', 'Elsewhere_2026_01_02_00_00_00', 'src/migrations'],
    ];

    for (const [section, entries, kept, dropped, searched] of SECTIONS) {
      it(`is dropped from ${section} and reported with its file and the dirs searched`, () => {
        expect(names(entries())).to.include(kept);
        expect(names(entries())).to.not.include(dropped);

        const reported = about(withCode(fragment.diagnostics, 'CMP006'), dropped);
        expect(reported?.severity).to.equal('warning');
        expect(reported?.source?.file).to.equal(`src/elsewhere/${dropped}.ts`);
        expect(reported?.message).to.include(`src/elsewhere/${dropped}.ts`);
        expect(reported?.message).to.include(searched);
      });
    }

    it('keeps a class in a folder below a declared dir, which discovery scans recursively', () => {
      expect(names(fragment.controllers)).to.include('NestedController');
    });

    it('does not take a sibling folder with the same prefix for a declared dir', () => {
      expect(names(fragment.controllers)).to.not.include('OldController');
    });

    it('keeps a controller registered in the DI container, which the registry source hands over from any file', () => {
      expect(names(fragment.controllers)).to.include('RegisteredController');
      expect(about(withCode(fragment.diagnostics, 'CMP006'), 'RegisteredController')).to.equal(undefined);
    });

    it('reports no absolute path: the manifest hash must not depend on the checkout', () => {
      expect(fragment.diagnostics.filter((d) => d.message.includes(ROOT))).to.deep.equal([]);
    });
  });

  describe('a section with no effective dir in the app', () => {
    const CASES: Array<[string, EffectiveDirs]> = [
      ['the key is absent', {}],
      ['the key is empty', { controllers: [] }],
      ['every dir belongs to a package', { controllers: [PACKAGE_DIR] }],
    ];

    for (const [title, dirs] of CASES) {
      it(`keeps every class and warns about each when ${title}`, async () => {
        const fragment = await analyze(dirs);
        expect(names(fragment.controllers)).to.include.members(['KeptController', 'ElsewhereController', 'ShopController']);
        const warning = about(withCode(fragment.diagnostics, 'CMP007'), 'ElsewhereController');
        expect(warning?.severity).to.equal('warning');
        expect(warning?.message).to.include('system.dirs.controllers');
        expect(warning?.source?.file).to.equal('src/elsewhere/ElsewhereController.ts');
      });
    }

    it('does not warn about the DI-registered controller, which discovery does load', async () => {
      const fragment = await analyze({});
      expect(about(withCode(fragment.diagnostics, 'CMP007'), 'RegisteredController')).to.equal(undefined);
    });
  });

  it('keeps migrations an app leaves to the default dirs the CLI hands over', async () => {
    const defaults = ['src', 'lib', 'dist', 'build', '.'].map((d) => join(ROOT, d, 'migrations'));
    const fragment = await analyze({ ...DIRS, migrations: defaults });
    expect(names(fragment.migrations)).to.deep.equal(['Kept_2026_01_01_00_00_00']);
    expect(withCode(fragment.diagnostics, 'CMP007')).to.deep.equal([]);
  });

  it('keeps the classes of a RunApp layout, under the dir `applyAppDirs` adds', async () => {
    const fragment = await analyze({ controllers: [...built('controllers'), join(ROOT, 'lib', 'apps', 'shop', 'controllers')] });
    expect(names(fragment.controllers)).to.include.members(['KeptController', 'ShopController']);
    expect(names(fragment.controllers)).to.not.include('ElsewhereController');
  });

  it('drops the classes of another RunApp', async () => {
    const fragment = await analyze({ controllers: [...built('controllers'), join(ROOT, 'lib', 'apps', 'other', 'controllers')] });
    expect(names(fragment.controllers)).to.not.include('ShopController');
  });

  it('takes a dir that points at the sources, as an app run through ts-node has it', async () => {
    const fragment = await analyze({ controllers: [join(ROOT, 'src', 'controllers')] });
    expect(names(fragment.controllers)).to.include('KeptController');
    expect(names(fragment.controllers)).to.not.include('ElsewhereController');
  });

  it('reads a relative dir from the app root', async () => {
    const fragment = await analyze({ controllers: ['lib/controllers'] });
    expect(names(fragment.controllers)).to.include('KeptController');
    expect(names(fragment.controllers)).to.not.include('ElsewhereController');
  });

  it('maps an outDir without a rootDir option back through the common source dir', async () => {
    const fragment = await analyze({ controllers: [join(ROOT, 'dist', 'controllers')] }, 'tsconfig.dist.json');
    expect(names(fragment.controllers)).to.include('KeptController');
    expect(names(fragment.controllers)).to.not.include('ElsewhereController');
  });

  it('still finds src/ under a tsconfig whose rootDir is the app root: the manifest runtime resolves src/x to <outDir>/x', async () => {
    const fragment = await analyze({ controllers: built('controllers') }, 'tsconfig.root.json');
    expect(names(fragment.controllers)).to.include('KeptController');
    expect(names(fragment.controllers)).to.not.include('ElsewhereController');
  });

  it('goes through buildAppManifest, and a call without the data stays unfiltered', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spinajs-effective-dirs-'));
    try {
      const out = join(dir, 'app.manifest.json');
      await buildAppManifest({ tsconfig: join(ROOT, 'tsconfig.json'), appRoot: ROOT, out, schemaDerivation: false, effectiveDirs: DIRS });
      const manifest = JSON.parse(readFileSync(out, 'utf8')) as Manifest;
      expect(names(manifest.controllers)).to.not.include('ElsewhereController');
      expect(about(withCode(manifest.diagnostics, 'CMP006'), 'ElsewhereController')).to.not.equal(undefined);

      const { manifest: unfiltered } = await buildAppManifest({ tsconfig: join(ROOT, 'tsconfig.json'), appRoot: ROOT, out, schemaDerivation: false });
      expect(names(unfiltered.controllers)).to.include('ElsewhereController');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
