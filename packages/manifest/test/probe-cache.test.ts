import 'mocha';
import { expect } from 'chai';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appRootOf, isPackageSkipped, manifestFileFor, ManifestMissing, ownEntries, packageRootOf } from '../src/runtime.js';
import { existingRealpathOf, realpathOf } from '../src/realpath.js';
import type { Manifest } from '../src/index.js';

const FIX = resolve(process.cwd(), 'test', 'fixtures', 'runtime');
const PROBES = ['existsSync', 'statSync', 'lstatSync', 'realpathSync', 'readFileSync'] as const;
type Probe = (typeof PROBES)[number];

const nodeFs = createRequire(import.meta.url)('node:fs') as Record<Probe, (...args: unknown[]) => unknown>;

/** Every listed fs call made while `run` runs, by the module under test too: its named imports follow `syncBuiltinESMExports`. */
function fsCalls(run: () => void): Record<Probe, string[]> {
  const calls = Object.fromEntries(PROBES.map((p) => [p, [] as string[]])) as Record<Probe, string[]>;
  const originals = PROBES.map((p) => [p, nodeFs[p]] as const);
  for (const [name, original] of originals) {
    nodeFs[name] = Object.assign((...args: unknown[]) => {
      calls[name].push(String(args[0]));
      return original(...args);
    }, original);
  }
  syncBuiltinESMExports();
  try {
    run();
  } finally {
    for (const [name, original] of originals) nodeFs[name] = original;
    syncBuiltinESMExports();
  }
  return calls;
}

const base = JSON.parse(readFileSync(join(FIX, 'app.manifest.json'), 'utf8')) as Manifest;
const entryOf = (file: string, pkg: string) => ({ source: { file, line: 1, col: 1, package: pkg } });

describe('manifest runtime probes', () => {
  let ws: string;
  let app: string;
  let manifest: Manifest;
  const files = Array.from({ length: 12 }, (_, i) => `C${i}`);

  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), 'spinajs-probes-')));
    app = join(ws, 'apps', 'app');
    const dep = join(ws, 'node_modules', '@spinajs', 'dep');
    mkdirSync(join(app, 'lib', 'controllers'), { recursive: true });
    mkdirSync(join(dep, 'lib', 'cli'), { recursive: true });
    writeFileSync(join(dep, 'package.json'), JSON.stringify({ name: '@spinajs/dep' }));
    for (const f of files) {
      writeFileSync(join(app, 'lib', 'controllers', `${f}.js`), '');
      writeFileSync(join(dep, 'lib', 'cli', `${f}.js`), '');
    }
    manifest = { ...base, app: { ...base.app, name: 'app', root: app }, packages: [{ name: '@spinajs/dep', version: '0.0.0', entry: 'lib/index.js', fragment: 'lib/manifest.fragment.json', outDir: 'lib' }] };
  });

  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  const resolveAll = (pkg: string, dir: string) => files.map((f) => manifestFileFor(entryOf(`src/${dir}/${f}.ts`, pkg), manifest, app));

  it('locates a dependency root once for all of its entries', () => {
    const lookups = fsCalls(() => resolveAll('@spinajs/dep', 'cli')).existsSync.filter((p) => p.endsWith('package.json'));
    expect(lookups).to.have.length.within(1, 3);
    expect(new Set(lookups).size).to.equal(lookups.length);
  });

  it('checks the app root once for all of its entries', () => {
    const calls = fsCalls(() => resolveAll('app', 'controllers'));
    expect(calls.existsSync.filter((p) => p === app)).to.have.length(1);
  });

  it('takes the real path of a root and of a directory once, not of every file', () => {
    for (const [pkg, dir] of [['app', 'controllers'], ['@spinajs/dep', 'cli']]) {
      const calls = fsCalls(() => resolveAll(pkg, dir));
      expect(calls.realpathSync.filter((p) => p.endsWith('.js')), pkg).to.deep.equal([]);
      expect(calls.realpathSync.length, pkg).to.be.at.most(3);
      expect(calls.lstatSync.length + calls.existsSync.length + calls.statSync.length, pkg).to.be.at.most(files.length + 3);
    }
  });

  it('reads the SPINAJS_PACKAGE_ROOTS map once per package', () => {
    mkdirSync(join(app, 'pkgs', 'dep', 'lib', 'cli'), { recursive: true });
    writeFileSync(join(app, 'package-roots.json'), JSON.stringify({ '@spinajs/dep': 'pkgs/dep' }));
    process.env.SPINAJS_PACKAGE_ROOTS = join(app, 'package-roots.json');
    try {
      const calls = fsCalls(() => resolveAll('@spinajs/dep', 'cli'));
      expect(calls.readFileSync.filter((p) => p.endsWith('package-roots.json'))).to.have.length(1);
    } finally {
      delete process.env.SPINAJS_PACKAGE_ROOTS;
    }
  });

  it('returns what it returned before caching', () => {
    expect(resolveAll('app', 'controllers')).to.deep.equal(files.map((f) => join(app, 'lib', 'controllers', `${f}.js`)));
    expect(resolveAll('@spinajs/dep', 'cli')).to.deep.equal(files.map((f) => join(ws, 'node_modules', '@spinajs', 'dep', 'lib', 'cli', `${f}.js`)));
    expect(resolveAll('@spinajs/dep', 'cli')).to.deep.equal(files.map((f) => join(ws, 'node_modules', '@spinajs', 'dep', 'lib', 'cli', `${f}.js`)));
  });

  describe('keys', () => {
    it('does not share roots between manifests', () => {
      const other = join(ws, 'other');
      mkdirSync(join(other, 'node_modules', '@spinajs', 'dep'), { recursive: true });
      writeFileSync(join(other, 'node_modules', '@spinajs', 'dep', 'package.json'), '{}');
      const moved = { ...manifest, app: { ...manifest.app, root: other } };
      expect(packageRootOf('@spinajs/dep', manifest, app)).to.equal(join(ws, 'node_modules', '@spinajs', 'dep'));
      expect(packageRootOf('@spinajs/dep', moved, app)).to.equal(join(other, 'node_modules', '@spinajs', 'dep'));
    });

    it('follows SPINAJS_MANIFEST_ROOT on the same manifest', () => {
      const other = join(ws, 'other');
      mkdirSync(join(other, 'node_modules', '@spinajs', 'dep'), { recursive: true });
      writeFileSync(join(other, 'node_modules', '@spinajs', 'dep', 'package.json'), '{}');
      expect(packageRootOf('@spinajs/dep', manifest, app)).to.equal(join(ws, 'node_modules', '@spinajs', 'dep'));
      process.env.SPINAJS_MANIFEST_ROOT = other;
      try {
        expect(appRootOf(manifest, app)).to.equal(other);
        expect(packageRootOf('@spinajs/dep', manifest, app)).to.equal(join(other, 'node_modules', '@spinajs', 'dep'));
      } finally {
        delete process.env.SPINAJS_MANIFEST_ROOT;
      }
      expect(packageRootOf('@spinajs/dep', manifest, app)).to.equal(join(ws, 'node_modules', '@spinajs', 'dep'));
    });

    it('follows cwd when app.root is missing', () => {
      const gone = { ...manifest, app: { ...manifest.app, root: join(ws, 'gone') } };
      expect(appRootOf(gone, app)).to.equal(app);
      expect(appRootOf(gone, ws)).to.equal(ws);
    });

    it('looks again for a package that was not installed', () => {
      const late = { ...manifest, packages: [...manifest.packages, { ...manifest.packages[0], name: '@spinajs/late' }] };
      expect(isPackageSkipped('@spinajs/late', late, app, 'prefer')).to.equal(true);
      mkdirSync(join(ws, 'node_modules', '@spinajs', 'late'), { recursive: true });
      writeFileSync(join(ws, 'node_modules', '@spinajs', 'late', 'package.json'), '{}');
      expect(isPackageSkipped('@spinajs/late', late, app, 'prefer')).to.equal(false);
    });

    it('refuses an unlisted package every time', () => {
      expect(() => packageRootOf('@spinajs/ghost', manifest, app)).to.throw(ManifestMissing, /ghost/);
      expect(() => packageRootOf('@spinajs/ghost', manifest, app)).to.throw(ManifestMissing, /ghost/);
    });
  });

  describe('containment after the roots are cached', () => {
    let outside: string;
    beforeEach(() => {
      outside = realpathSync(mkdtempSync(join(tmpdir(), 'spinajs-probes-outside-')));
      mkdirSync(join(outside, 'evil.js'));
      writeFileSync(join(outside, 'x.js'), '');
      resolveAll('app', 'controllers');
    });
    afterEach(() => rmSync(outside, { recursive: true, force: true }));

    it('refuses a file under a linked directory created later', () => {
      symlinkSync(outside, join(app, 'lib', 'controllers', 'linked'), 'junction');
      expect(() => manifestFileFor(entryOf('src/controllers/linked/x.ts', 'app'), manifest, app)).to.throw(ManifestMissing, /leaves the root/);
    });

    it('refuses an entry that is itself a link out of the root', () => {
      symlinkSync(join(outside, 'evil.js'), join(app, 'lib', 'controllers', 'evil.js'), 'junction');
      expect(() => manifestFileFor(entryOf('src/controllers/evil.ts', 'app'), manifest, app)).to.throw(ManifestMissing, /leaves the root/);
    });

    it('accepts a missing file and still refuses `..`', () => {
      expect(manifestFileFor(entryOf('src/controllers/missing.ts', 'app'), manifest, app)).to.equal(join(app, 'lib', 'controllers', 'missing.js'));
      expect(() => manifestFileFor(entryOf('src/../../x.ts', 'app'), manifest, app)).to.throw(ManifestMissing, /leaves the root/);
    });
  });

  it('tells a class by its own file through a link to it', () => {
    symlinkSync(join(app, 'lib', 'controllers'), join(app, 'lib', 'alias'), 'junction');
    const candidates = [{ name: 'a', ...entryOf('src/controllers/C1.ts', 'app') }, { name: 'b', ...entryOf('src/controllers/C2.ts', 'app') }];
    expect(ownEntries(candidates, { file: join(app, 'lib', 'alias', 'C2.js') }, manifest, app).map((c) => c.name)).to.deep.equal(['b']);
  });
});

describe('realpathOf', () => {
  let root: string;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'spinajs-realpath-'));
    mkdirSync(join(root, 'real', 'sub'), { recursive: true });
    writeFileSync(join(root, 'real', 'sub', 'a.js'), '');
    symlinkSync(join(root, 'real'), join(root, 'link'), 'junction');
    symlinkSync(join(root, 'real', 'sub'), join(root, 'real', 'sub-link'), 'junction');
    symlinkSync(join(root, 'nowhere'), join(root, 'broken'), 'junction');
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  const paths = () => ['real/sub/a.js', 'link/sub/a.js', 'link', 'link/sub', 'real/sub-link/a.js', 'link/sub-link', 'real/sub-link', 'real', ''].map((p) => join(root, p));

  it('gives what realpathSync gives, sharing the real directories', () => {
    const realDirs = new Map<string, string>();
    for (const path of [...paths(), ...paths()]) {
      expect(realpathOf(path, realDirs), path).to.equal(realpathSync(path));
      expect(existingRealpathOf(path, realDirs), path).to.equal(realpathSync(path));
    }
  });

  it('throws what realpathSync throws, and is undefined where existsSync is false', () => {
    for (const path of [join(root, 'missing.js'), join(root, 'broken'), join(root, 'real', 'sub', 'a.js', 'x')]) {
      const expected = (() => {
        try {
          return realpathSync(path);
        } catch (err) {
          return (err as Error).message;
        }
      })();
      expect(() => realpathOf(path, new Map()), path).to.throw(expected);
      expect(existingRealpathOf(path, new Map()), path).to.equal(undefined);
    }
  });
});
