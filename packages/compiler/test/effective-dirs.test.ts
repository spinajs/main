import 'mocha';
import { expect } from 'chai';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Diagnostic, Manifest, ManifestFragment } from '@spinajs/manifest';
import { analyzePackage, buildAppManifest, emitRootOf, NoAppDirs, type EffectiveDirs } from '../src/index.js';

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

type Entry = { className: string; mountedBy?: string };

const analyze = (effectiveDirs?: EffectiveDirs, tsconfig = 'tsconfig.json'): Promise<ManifestFragment> =>
  analyzePackage({ tsconfig: join(ROOT, tsconfig), packageRoot: ROOT, schemaDerivation: false, effectiveDirs });

const names = (entries: Entry[]): string[] => entries.map((e) => e.className).sort();
const loaded = (entries: Entry[]): string[] => names(entries.filter((e) => e.mountedBy === undefined));
const flagged = (entries: Entry[]): string[] => names(entries.filter((e) => e.mountedBy === 'di'));
const withCode = (diagnostics: Diagnostic[], code: string): Diagnostic[] => diagnostics.filter((d) => d.code === code);
const about = (diagnostics: Diagnostic[], className: string): Diagnostic | undefined => diagnostics.find((d) => d.message.includes(className));

describe("an app's classes against its effective dirs", function () {
  this.timeout(60_000);

  it('flags nothing without the data, as a direct call of the analyzer always did', async () => {
    const fragment = await analyze();
    expect(fragment.scanFiles).to.equal(undefined);
    expect(loaded(fragment.controllers)).to.include.members(['ElsewhereController', 'ShopController', 'OldController']);
    expect(flagged(fragment.controllers)).to.deep.equal([]);
    expect(withCode(fragment.diagnostics, 'CMP006')).to.deep.equal([]);
  });

  describe('a class outside every dir of its section', () => {
    let fragment: ManifestFragment;

    before(async () => {
      fragment = await analyze(DIRS);
    });

    const SECTIONS: Array<[string, () => Entry[], string, string, string]> = [
      ['controllers', () => fragment.controllers, 'KeptController', 'ElsewhereController', 'src/controllers'],
      ['socket controllers', () => fragment.socketControllers, 'KeptSocket', 'ElsewhereSocket', 'src/sockets'],
      ['schedules', () => fragment.schedules, 'KeptTask', 'ElsewhereTask', 'src/schedules'],
      ['commands', () => fragment.commands, 'KeptCommand', 'ElsewhereCommand', 'src/commands'],
      ['migrations', () => fragment.migrations, 'Kept_2026_01_01_00_00_00', 'Elsewhere_2026_01_02_00_00_00', 'src/migrations'],
    ];

    for (const [section, entries, kept, outside, searched] of SECTIONS) {
      it(`stays in ${section} as an entry the manifest does not load, and is reported with its file and the dirs searched`, () => {
        expect(loaded(entries())).to.include(kept);
        expect(flagged(entries())).to.include(outside);

        const reported = about(withCode(fragment.diagnostics, 'CMP006'), outside);
        expect(reported?.severity).to.equal('warning');
        expect(reported?.source?.file).to.equal(`src/elsewhere/${outside}.ts`);
        expect(reported?.message).to.include(`src/elsewhere/${outside}.ts`);
        expect(reported?.message).to.include(searched);
      });
    }

    it('keeps its metadata', () => {
      const entry = fragment.controllers.find((c) => c.className === 'ElsewhereController');
      expect(entry?.routes.map((r) => r.handler)).to.deep.equal(['get']);
    });

    it('stays flagged when it declares @Injectable(BaseController): nothing proves its file is imported', () => {
      expect(flagged(fragment.controllers)).to.include('InjectableNeverImported');
      expect(about(withCode(fragment.diagnostics, 'CMP006'), 'InjectableNeverImported')).to.not.equal(undefined);
    });

    it('stays flagged when a registration behind a guard names it: nothing proves that guard opens', () => {
      expect(flagged(fragment.controllers)).to.include('DebugController');
    });

    it('stays flagged for every class of a name a registration uses', () => {
      const admins = fragment.controllers.filter((c) => c.className === 'AdminController');
      expect(admins.map((c) => c.source.file).sort()).to.deep.equal(['src/elsewhere/AdminController.ts', 'src/plugin/AdminController.ts']);
      expect(admins.map((c) => c.mountedBy)).to.deep.equal(['di', 'di']);
    });

    it('stays flagged when a registration names it directly', () => {
      expect(flagged(fragment.controllers)).to.include('RegisteredController');
    });

    it('is loaded in a folder below a declared dir, which discovery scans recursively', () => {
      expect(loaded(fragment.controllers)).to.include('NestedController');
    });

    it('is not mistaken for a member of a sibling folder with the same prefix', () => {
      expect(flagged(fragment.controllers)).to.include('OldController');
    });

    it('is loaded when a file under a declared dir exports it: discovery walks the exports, wherever the class is declared', () => {
      expect(loaded(fragment.controllers)).to.include.members(['BarrelledController', 'StarController']);
      expect(fragment.controllers.find((c) => c.className === 'BarrelledController')?.source.file).to.equal('src/elsewhere/BarrelledController.ts');
      expect(about(withCode(fragment.diagnostics, 'CMP006'), 'BarrelledController')).to.equal(undefined);
    });

    for (const [form, className] of [
      ['export type { X } from', 'TypeOnlyController'],
      ['export type *', 'TypeStarController'],
      ['import type, then export { X }', 'ImportTypeController'],
      ['import { type X }, then export { X }', 'InlineTypeController'],
      ['export { type X } from', 'SpecifierTypeController'],
      ['export * of a barrel holding export type *', 'ThroughBarrelController'],
    ]) {
      it(`stays flagged and reported for ${form}, which emits nothing`, () => {
        expect(flagged(fragment.controllers)).to.include(className);
        expect(about(withCode(fragment.diagnostics, 'CMP006'), className)).to.not.equal(undefined);
      });
    }

    for (const [form, className] of [
      ['export const Served = X', 'ConstController'],
      ['export { X as Renamed } of an import', 'ImportedValueController'],
      ['export const Visible = X of a class no file exports by name', 'AliasedController'],
    ]) {
      it(`is loaded for ${form}: discovery takes any class-valued export`, () => {
        expect(loaded(fragment.controllers)).to.include(className);
      });
    }

    it('is not called an export of a dir for a command nothing exports, as the CLI reads exports', () => {
      expect(flagged(fragment.commands)).to.include('HiddenCommand');
    });

    it('is loaded in the sections that register on import when a file under the dir declares it, exported or not', () => {
      expect(loaded(fragment.schedules)).to.include('UnexportedTask');
      expect(loaded(fragment.socketControllers)).to.include('UnexportedSocket');
      expect(loaded(fragment.migrations)).to.include('Unexported_2026_01_03_00_00_00');
    });

    it('is loaded in those sections when a file under the dir imports its file', () => {
      expect(loaded(fragment.schedules)).to.include('ViaImportTask');
    });

    it('stays flagged when the import that names it is elided from the output', () => {
      expect(flagged(fragment.schedules)).to.include('ElidedTask');
      expect(about(withCode(fragment.diagnostics, 'CMP006'), 'ElidedTask')?.message).to.include('imports it');
    });

    it('lists the files a scan imports that no loaded entry brings in, per section', () => {
      const files = (section: string): string[] => (fragment.scanFiles ?? []).filter((f) => f.section === section).map((f) => f.source.file);
      expect(files('controllers')).to.include('src/controllers/register.ts');
      expect(files('controllers')).to.not.include('src/controllers/KeptController.ts');
      expect(files('schedules')).to.include('src/schedules/index.ts');
      expect(files('schedules')).to.not.include('src/schedules/KeptTask.ts');
    });

    it('stays flagged in a file no scan matches: the glob of the section is .ts and .js', () => {
      expect(flagged(fragment.controllers)).to.include('ModernController');
    });

    it('leaves a dotted migration file to the environment test at runtime, as only then the glob is known', () => {
      expect(loaded(fragment.migrations)).to.include.members(['Legacy_2026_02_02_00_00_00', 'Tested_2026_02_03_00_00_00']);
      expect((fragment.scanFiles ?? []).map((f) => f.source.file)).to.include('src/migrations/helper.util.ts');
    });

    it('flags a migration only a tagged file imports: it must not load in every environment', () => {
      expect(flagged(fragment.migrations)).to.include('OnlyTagged_2026_02_04_00_00_00');
    });

    it('stays flagged for a controller a side-effect file registers: the registration decides, not the manifest', () => {
      expect(flagged(fragment.controllers)).to.include('SideEffectController');
    });

    it('stays flagged under a declared dir when no file exports it, as discovery never sees it', () => {
      expect(flagged(fragment.controllers)).to.include('HiddenController');
    });

    it('reports no absolute path: the manifest hash must not depend on the checkout', () => {
      expect(fragment.diagnostics.filter((d) => d.message.includes(ROOT))).to.deep.equal([]);
    });
  });

  describe('a section with no dir in the app', () => {
    const CASES: Array<[string, EffectiveDirs]> = [
      ['the key is absent', {}],
      ['the key is empty', { controllers: [] }],
      ['every dir belongs to a package', { controllers: [PACKAGE_DIR] }],
      ['a dir maps to a source folder that does not exist', { controllers: built('lib/controllers') }],
      ['a dir has a level the outDir lacks', { controllers: built('mjs/controllers') }],
    ];

    for (const [title, dirs] of CASES) {
      it(`means an empty section when another one maps into the app: ${title}`, async () => {
        const fragment = await analyze({ schedules: built('schedules'), ...dirs });
        expect(loaded(fragment.controllers)).to.deep.equal([]);
        expect(flagged(fragment.controllers)).to.include.members(['KeptController', 'ElsewhereController']);
        const warning = about(withCode(fragment.diagnostics, 'CMP006'), 'KeptController');
        expect(warning?.severity).to.equal('warning');
        expect(warning?.message).to.include('system.dirs.controllers');
        expect(warning?.source?.file).to.equal('src/controllers/KeptController.ts');
      });
    }
  });

  describe('no dir of any section in the app', () => {
    const refused = async (dirs: EffectiveDirs, options: Partial<Parameters<typeof analyzePackage>[0]> = {}): Promise<unknown> => {
      try {
        await analyzePackage({ tsconfig: join(ROOT, 'tsconfig.json'), packageRoot: ROOT, schemaDerivation: false, effectiveDirs: dirs, requireAppDirs: true, ...options });
        return undefined;
      } catch (e) {
        return e;
      }
    };

    it('is refused when the caller requires dirs, naming what was searched', async () => {
      const error = await refused({ controllers: [PACKAGE_DIR, ...built('lib/controllers')] });
      expect(error).to.be.instanceOf(NoAppDirs);
      expect((error as Error).message).to.include('controllers: lib/lib/controllers');
      expect((error as Error).message).to.not.include('node_modules');
    });

    it('is refused with nothing to name', async () => {
      expect(((await refused({})) as Error).message).to.include('none');
    });

    it('is not refused for an app with no class to filter: a config-only app has nothing to get wrong', async () => {
      const root = resolve('test/fixtures/app-empty');
      const fragment = await analyzePackage({ tsconfig: join(root, 'tsconfig.json'), packageRoot: root, schemaDerivation: false, effectiveDirs: {}, requireAppDirs: true });
      expect(fragment.controllers).to.deep.equal([]);
    });

    it('is not rescued by a default dir, which exists without any config', async () => {
      const error = await refused({}, { defaultDirs: { migrations: built('migrations') } });
      expect(error).to.be.instanceOf(NoAppDirs);
    });

    it('is not refused when a migrations dir is configured: that one was read from config', async () => {
      expect(await refused({ migrations: built('migrations') })).to.equal(undefined);
    });

    it('flags every class when the caller does not require dirs, as discovery loads none', async () => {
      const fragment = await analyze({});
      for (const section of [fragment.controllers, fragment.socketControllers, fragment.schedules, fragment.commands, fragment.migrations]) {
        expect(section.length).to.be.greaterThan(0);
        expect(loaded(section)).to.deep.equal([]);
      }
    });
  });

  it('lets a default dir filter its section, and configured dirs replace it', async () => {
    const options = { tsconfig: join(ROOT, 'tsconfig.json'), packageRoot: ROOT, schemaDerivation: false, defaultDirs: { migrations: built('migrations') } };
    const byDefault = await analyzePackage({ ...options, effectiveDirs: { controllers: built('controllers') } });
    expect(loaded(byDefault.migrations)).to.deep.equal(['Kept_2026_01_01_00_00_00', 'Legacy_2026_02_02_00_00_00', 'Tested_2026_02_03_00_00_00', 'Unexported_2026_01_03_00_00_00']);
    const replaced = await analyzePackage({ ...options, effectiveDirs: { controllers: built('controllers'), migrations: built('elsewhere') } });
    expect(loaded(replaced.migrations)).to.deep.equal(['Elsewhere_2026_01_02_00_00_00', 'OnlyTagged_2026_02_04_00_00_00']);
  });

  it('does not read an installed package as part of the app when the rootDir is the app root', async () => {
    const installed = join(ROOT, 'node_modules', 'some-package');
    mkdirSync(join(installed, 'lib', 'controllers'), { recursive: true });
    try {
      const fragment = await analyze({ controllers: [join(installed, 'lib', 'controllers')], schedules: built('schedules') }, 'tsconfig.root.json');
      expect(about(withCode(fragment.diagnostics, 'CMP006'), 'KeptController')?.message).to.not.include('some-package');
    } finally {
      rmSync(join(ROOT, 'node_modules'), { recursive: true, force: true });
    }
  });

  it('warns once about a configured dir of the app that has no source folder behind it', async () => {
    const fragment = await analyze({ controllers: built('controllers'), schedules: built('lib/schedules') });
    const warnings = withCode(fragment.diagnostics, 'CMP008');
    expect(warnings.map((d) => d.severity)).to.deep.equal(['warning']);
    expect(warnings[0].message).to.include('system.dirs.schedules');
    expect(warnings[0].message).to.include('lib/lib/schedules');
  });

  it('does not warn about a package dir, or a dir of a section that maps', async () => {
    const fragment = await analyze(DIRS);
    expect(withCode(fragment.diagnostics, 'CMP008')).to.deep.equal([]);
  });

  it('does not list a JSON file under a dir: no scan matches it, and importing it without an attribute throws', async () => {
    const fragment = await analyze(DIRS, 'tsconfig.json-files.json');
    expect((fragment.scanFiles ?? []).map((f) => f.source.file)).to.not.include('src/controllers/data.json');
    expect((fragment.scanFiles ?? []).map((f) => f.source.file)).to.include('src/controllers/register.ts');
  });

  it('ignores a dir that maps to nothing beside one that maps', async () => {
    const fragment = await analyze({ controllers: built('mjs/controllers', 'controllers') });
    expect(loaded(fragment.controllers)).to.include('KeptController');
    expect(flagged(fragment.controllers)).to.include('ElsewhereController');
    expect(about(withCode(fragment.diagnostics, 'CMP006'), 'ElsewhereController')?.message).to.not.include('src/mjs');
  });

  it('keeps migrations an app leaves to the default dirs the CLI hands over', async () => {
    const defaults = ['src', 'lib', 'dist', 'build', '.'].map((d) => join(ROOT, d, 'migrations'));
    const fragment = await analyze({ ...DIRS, migrations: defaults });
    expect(loaded(fragment.migrations)).to.deep.equal(['Kept_2026_01_01_00_00_00', 'Legacy_2026_02_02_00_00_00', 'Tested_2026_02_03_00_00_00', 'Unexported_2026_01_03_00_00_00']);
  });

  it('loads the classes of a RunApp layout, under the dir `applyAppDirs` adds', async () => {
    const fragment = await analyze({ controllers: [...built('controllers'), join(ROOT, 'lib', 'apps', 'shop', 'controllers')] });
    expect(loaded(fragment.controllers)).to.include.members(['KeptController', 'ShopController']);
    expect(flagged(fragment.controllers)).to.include('ElsewhereController');
  });

  it('flags the classes of another RunApp', async () => {
    const fragment = await analyze({ controllers: [...built('controllers'), join(ROOT, 'lib', 'apps', 'other', 'controllers')] });
    expect(flagged(fragment.controllers)).to.include('ShopController');
  });

  it('takes a dir that points at the sources, as an app run through ts-node has it', async () => {
    const fragment = await analyze({ controllers: [join(ROOT, 'src', 'controllers')] });
    expect(loaded(fragment.controllers)).to.include('KeptController');
    expect(flagged(fragment.controllers)).to.include('ElsewhereController');
  });

  it('takes a dir above the sources for all of them, as a recursive scan does', async () => {
    const fragment = await analyze({ controllers: [ROOT, ...built('controllers')] });
    expect(loaded(fragment.controllers)).to.include('ElsewhereController');
    expect(flagged(fragment.controllers)).to.deep.equal(['HiddenController', 'ModernController']);
  });

  it('takes a dir above the outDir for all sources, as a recursive scan of the build does', async () => {
    const fragment = await analyze({ controllers: [join(ROOT, 'dist'), join(ROOT, 'dist', 'server', 'controllers')] }, 'tsconfig.nested.json');
    expect(loaded(fragment.controllers)).to.include('ElsewhereController');
    expect(flagged(fragment.controllers)).to.deep.equal(['HiddenController', 'ModernController']);
  });

  it('reads a relative dir from the app root', async () => {
    const fragment = await analyze({ controllers: ['lib/controllers'] });
    expect(loaded(fragment.controllers)).to.include('KeptController');
    expect(flagged(fragment.controllers)).to.include('ElsewhereController');
  });

  it('maps an outDir without a rootDir option back through the common source dir', async () => {
    const fragment = await analyze({ controllers: [join(ROOT, 'dist', 'controllers')] }, 'tsconfig.dist.json');
    expect(loaded(fragment.controllers)).to.include('KeptController');
    expect(flagged(fragment.controllers)).to.include('ElsewhereController');
  });

  it('still finds src/ under a tsconfig whose rootDir is the app root: the manifest runtime resolves src/x to <outDir>/x', async () => {
    const fragment = await analyze({ controllers: built('controllers') }, 'tsconfig.root.json');
    expect(loaded(fragment.controllers)).to.include('KeptController');
    expect(flagged(fragment.controllers)).to.include('ElsewhereController');
  });

  it('goes through buildAppManifest, and a call without the data stays unfiltered', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spinajs-effective-dirs-'));
    try {
      const out = join(dir, 'app.manifest.json');
      await buildAppManifest({ tsconfig: join(ROOT, 'tsconfig.json'), appRoot: ROOT, out, schemaDerivation: false, effectiveDirs: DIRS });
      const manifest = JSON.parse(readFileSync(out, 'utf8')) as Manifest;
      expect(flagged(manifest.controllers)).to.include('ElsewhereController');
      expect(about(withCode(manifest.diagnostics, 'CMP006'), 'ElsewhereController')).to.not.equal(undefined);

      const { manifest: unfiltered } = await buildAppManifest({ tsconfig: join(ROOT, 'tsconfig.json'), appRoot: ROOT, out, schemaDerivation: false });
      expect(flagged(unfiltered.controllers)).to.deep.equal([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('emitRootOf', () => {
    const file = (...parts: string[]): string => join(ROOT, ...parts);

    it('takes the rootDir option first', () => {
      expect(emitRootOf(file('src'), undefined, ROOT, [file('src', 'a', 'x.ts')])).to.equal(file('src'));
    });

    it('takes the tsconfig folder of a composite project, as tsc does', () => {
      expect(emitRootOf(undefined, true, ROOT, [file('src', 'a', 'x.ts')])).to.equal(ROOT);
    });

    it('takes the common folder of the inputs otherwise', () => {
      expect(emitRootOf(undefined, undefined, ROOT, [file('src', 'a', 'x.ts'), file('src', 'b', 'y.ts')])).to.equal(file('src'));
    });

    it('falls back to the tsconfig folder without inputs', () => {
      expect(emitRootOf(undefined, undefined, dirname(ROOT), [])).to.equal(dirname(ROOT));
    });
  });
});
