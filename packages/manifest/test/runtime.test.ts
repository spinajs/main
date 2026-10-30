import 'mocha';
import { expect } from 'chai';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isPackageSkipped, loadRuntimeManifest, manifestFileFor, ManifestMissing, packageRootOf } from '../src/runtime.js';
import type { Manifest } from '../src/index.js';
import { hashManifest } from '../src/hash.js';

const FIX = resolve(process.cwd(), 'test', 'fixtures', 'runtime');

describe('loadRuntimeManifest', () => {
  it('returns undefined when mode is off, even if the file exists', () => {
    expect(loadRuntimeManifest({ path: 'app.manifest.json', mode: 'off' }, FIX)).to.equal(undefined);
  });

  it('reads a relative path against cwd', () => {
    const m = loadRuntimeManifest({ path: 'app.manifest.json', mode: 'prefer' }, FIX);
    expect(m?.app.name).to.equal('runtime-fixture');
  });

  it('reads an absolute path', () => {
    const m = loadRuntimeManifest({ path: resolve(FIX, 'app.manifest.json'), mode: 'require' }, '/elsewhere');
    expect(m?.app.name).to.equal('runtime-fixture');
  });

  it('prefer mode returns undefined when the file is missing', () => {
    expect(loadRuntimeManifest({ path: 'nope.json', mode: 'prefer' }, FIX)).to.equal(undefined);
  });

  it('require mode throws ManifestMissing when the file is missing', () => {
    expect(() => loadRuntimeManifest({ path: 'nope.json', mode: 'require' }, FIX)).to.throw(ManifestMissing, /nope.json/);
  });
});

describe('loadRuntimeManifest integrity', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spinajs-manifest-'));
    const m = JSON.parse(readFileSync(resolve(FIX, 'app.manifest.json'), 'utf8')) as Manifest;
    m.app.name = 'edited';
    writeFileSync(join(dir, 'app.manifest.json'), JSON.stringify(m));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('require mode throws on a hash mismatch', () => {
    expect(() => loadRuntimeManifest({ path: 'app.manifest.json', mode: 'require' }, dir)).to.throw(/stale or edited: hash mismatch, run spinajs build/);
  });

  it('prefer mode warns and falls back to discovery on a hash mismatch', () => {
    const warn = console.warn;
    const seen: string[] = [];
    console.warn = (msg: string) => void seen.push(msg);
    try {
      expect(loadRuntimeManifest({ path: 'app.manifest.json', mode: 'prefer' }, dir)).to.equal(undefined);
    } finally {
      console.warn = warn;
    }
    expect(seen.join()).to.match(/hash mismatch/);
  });

  it('accepts a manifest whose hash matches', () => {
    const m = JSON.parse(readFileSync(join(dir, 'app.manifest.json'), 'utf8')) as Manifest;
    m.hash = hashManifest(m);
    writeFileSync(join(dir, 'app.manifest.json'), JSON.stringify(m));
    expect(loadRuntimeManifest({ path: 'app.manifest.json', mode: 'require' }, dir)?.app.name).to.equal('edited');
  });

  it('rejects an unknown mode', () => {
    expect(() => loadRuntimeManifest({ path: 'app.manifest.json', mode: 'prefr' as never }, dir)).to.throw(/off, prefer, require/);
  });
});

describe('manifestFileFor', () => {
  const m = loadRuntimeManifest({ path: 'app.manifest.json', mode: 'prefer' }, FIX) as Manifest;

  it('maps an app src file onto the app root and outDir with a .js extension', () => {
    const entry = m.controllers.find((c) => c.className === 'A');
    expect(manifestFileFor(entry!, m, FIX)).to.equal(resolve(FIX, 'lib', 'controllers', 'A.js'));
  });

  it('maps a dependency src file onto the installed package root', () => {
    const entry = m.commands.find((c) => c.className === 'Cmd');
    expect(manifestFileFor(entry!, m, FIX)).to.equal(resolve(FIX, 'node_modules', '@spinajs', 'dep', 'lib', 'cli', 'Cmd.js'));
  });

  it('keeps a source that already sits under outDir', () => {
    const entry = { source: { file: 'lib/controllers/B.ts', line: 1, col: 1, package: 'runtime-fixture' } };
    expect(manifestFileFor(entry, m, FIX)).to.equal(resolve(FIX, 'lib', 'controllers', 'B.js'));
  });

  it('remaps app.root through SPINAJS_MANIFEST_ROOT', () => {
    const moved = { ...m, app: { ...m.app, root: '/built/elsewhere' } };
    process.env.SPINAJS_MANIFEST_ROOT = FIX;
    try {
      const entry = moved.controllers.find((c) => c.className === 'A');
      expect(manifestFileFor(entry!, moved, '/unrelated')).to.equal(resolve(FIX, 'lib', 'controllers', 'A.js'));
    } finally {
      delete process.env.SPINAJS_MANIFEST_ROOT;
    }
  });

  it('refuses a package the manifest does not list', () => {
    expect(() => packageRootOf('@spinajs/ghost', m, FIX)).to.throw(ManifestMissing, /ghost/);
  });

  it('finds a hoisted ESM-only package whose exports hide package.json and have no require condition', () => {
    const ws = mkdtempSync(join(tmpdir(), 'spinajs-esm-only-'));
    try {
      const pkgRoot = join(ws, 'node_modules', '@spinajs', 'esm-only');
      mkdirSync(join(pkgRoot, 'lib'), { recursive: true });
      writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: '@spinajs/esm-only', version: '0.0.0', type: 'module', exports: { '.': { import: './lib/index.js' } } }));
      writeFileSync(join(pkgRoot, 'lib', 'index.js'), '');
      const app = join(ws, 'apps', 'app');
      mkdirSync(app, { recursive: true });
      const local = { ...m, app: { ...m.app, root: app }, packages: [{ name: '@spinajs/esm-only', version: '0.0.0', entry: 'lib/index.js', fragment: 'node_modules/@spinajs/esm-only/lib/manifest.fragment.json', outDir: 'lib' }] };
      expect(packageRootOf('@spinajs/esm-only', local, app)).to.equal(realpathSync(pkgRoot));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  describe('containment', () => {
    const entryOf = (file: string, pkg = 'runtime-fixture') => ({ source: { file, line: 1, col: 1, package: pkg } });

    it('rejects `..` in source.file', () => {
      expect(() => manifestFileFor(entryOf('src/../../../x.ts'), m, FIX)).to.throw(ManifestMissing, /src\/\.\.\/\.\.\/\.\.\/x\.ts/);
    });

    it('rejects an absolute source.file', () => {
      expect(() => manifestFileFor(entryOf('/etc/x.ts'), m, FIX)).to.throw(ManifestMissing, /\/etc\/x\.ts/);
      expect(() => manifestFileFor(entryOf('C:\\x.ts'), m, FIX)).to.throw(ManifestMissing, /source file/);
    });

    it('rejects an outDir that leaves the root', () => {
      const bad = { ...m, app: { ...m.app, outDir: '../..' } };
      expect(() => manifestFileFor(entryOf('src/controllers/A.ts'), bad, FIX)).to.throw(ManifestMissing, /outDir|path/);
    });

    it('rejects an absolute outDir', () => {
      const bad = { ...m, app: { ...m.app, outDir: '/tmp' } };
      expect(() => manifestFileFor(entryOf('src/A.ts'), bad, FIX)).to.throw(ManifestMissing, /outDir '\/tmp'/);
    });

    it('rejects a symlinked directory pointing outside the root', function () {
      const root = mkdtempSync(join(tmpdir(), 'spinajs-root-'));
      const outside = mkdtempSync(join(tmpdir(), 'spinajs-outside-'));
      try {
        mkdirSync(join(root, 'lib'));
        writeFileSync(join(outside, 'evil.js'), '');
        try {
          symlinkSync(outside, join(root, 'lib', 'link'), 'junction');
        } catch {
          this.skip();
        }
        const local = { ...m, app: { ...m.app, name: 'local', root } };
        expect(() => manifestFileFor(entryOf('src/link/evil.ts', 'local'), local, root)).to.throw(ManifestMissing, /leaves the root/);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });
});

describe('isPackageSkipped', () => {
  let app: string;
  const listed = (name: string) => ({ name, version: '0.0.0', entry: 'lib/index.js', fragment: 'lib/manifest.fragment.json', outDir: 'lib' });
  const manifestOf = (...names: string[]): Manifest => {
    const base = JSON.parse(readFileSync(join(FIX, 'app.manifest.json'), 'utf8')) as Manifest;
    return { ...base, app: { ...base.app, name: 'skip-app', root: app }, packages: names.map(listed) };
  };

  beforeEach(() => {
    app = realpathSync(mkdtempSync(join(tmpdir(), 'spinajs-skipped-')));
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'skip-app', dependencies: { '@spinajs/direct': '0.0.0' }, peerDependencies: { '@spinajs/peer': '0.0.0' } }));
    mkdirSync(join(app, 'node_modules', '@spinajs', 'here'), { recursive: true });
    writeFileSync(join(app, 'node_modules', '@spinajs', 'here', 'package.json'), JSON.stringify({ name: '@spinajs/here' }));
  });

  afterEach(() => rmSync(app, { recursive: true, force: true }));

  it('keeps an installed package', () => {
    expect(isPackageSkipped('@spinajs/here', manifestOf('@spinajs/here'), app, 'require')).to.equal(false);
  });

  it('skips a listed package that is not installed, in prefer and require mode', () => {
    const m = manifestOf('@spinajs/peer');
    expect(isPackageSkipped('@spinajs/peer', m, app, 'prefer')).to.equal(true);
    expect(isPackageSkipped('@spinajs/peer', m, app, 'require')).to.equal(true);
  });

  it('fails require mode for a direct dependency of the app that is not installed, but not prefer', () => {
    const m = manifestOf('@spinajs/direct');
    expect(() => isPackageSkipped('@spinajs/direct', m, app, 'require')).to.throw(ManifestMissing, /@spinajs\/direct.*not installed/);
    expect(isPackageSkipped('@spinajs/direct', m, app, 'prefer')).to.equal(true);
  });
});

describe('SPINAJS_MANIFEST_ROOT', () => {
  const base = loadRuntimeManifest({ path: 'app.manifest.json', mode: 'prefer' }, FIX) as Manifest;
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'spinajs-remap-')));
    process.env.SPINAJS_MANIFEST_ROOT = root;
  });

  afterEach(() => {
    delete process.env.SPINAJS_MANIFEST_ROOT;
    rmSync(root, { recursive: true, force: true });
  });

  const moved = (): Manifest => ({ ...base, app: { ...base.app, root: '/built/elsewhere' } });
  const installDep = (): void => {
    mkdirSync(join(root, 'node_modules', '@spinajs', 'dep'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '@spinajs', 'dep', 'package.json'), JSON.stringify({ name: '@spinajs/dep' }));
  };

  it('resolves app files, dependency files and package roots under the remapped root', () => {
    installDep();
    const m = moved();
    expect(manifestFileFor(m.controllers.find((c) => c.className === 'A')!, m, '/unrelated')).to.equal(resolve(root, 'lib', 'controllers', 'A.js'));
    expect(manifestFileFor(m.commands.find((c) => c.className === 'Cmd')!, m, '/unrelated')).to.equal(resolve(root, 'node_modules', '@spinajs', 'dep', 'lib', 'cli', 'Cmd.js'));
    expect(isPackageSkipped('@spinajs/dep', m, '/unrelated', 'require')).to.equal(false);
  });

  it('takes the remap over an app.root that exists on this machine', () => {
    const m = { ...base, app: { ...base.app, root: FIX } };
    expect(manifestFileFor(m.controllers.find((c) => c.className === 'A')!, m, FIX)).to.equal(resolve(root, 'lib', 'controllers', 'A.js'));
  });

  it('keeps the containment checks: `..`, absolute paths and an escaping outDir are refused', () => {
    const m = moved();
    const entryOf = (file: string) => ({ source: { file, line: 1, col: 1, package: m.app.name } });
    expect(() => manifestFileFor(entryOf('src/../../../x.ts'), m, '/unrelated')).to.throw(ManifestMissing);
    expect(() => manifestFileFor(entryOf('/etc/x.ts'), m, '/unrelated')).to.throw(ManifestMissing);
    expect(() => manifestFileFor(entryOf('src/A.ts'), { ...m, app: { ...m.app, outDir: '../..' } }, '/unrelated')).to.throw(ManifestMissing, /leaves the root/);
  });

  it('keeps the symlink containment check under the remapped root', function () {
    const outside = mkdtempSync(join(tmpdir(), 'spinajs-remap-outside-'));
    try {
      mkdirSync(join(root, 'lib'));
      writeFileSync(join(outside, 'evil.js'), '');
      try {
        symlinkSync(outside, join(root, 'lib', 'link'), 'junction');
      } catch {
        this.skip();
      }
      const entry = { source: { file: 'src/link/evil.ts', line: 1, col: 1, package: base.app.name } };
      expect(() => manifestFileFor(entry, moved(), '/unrelated')).to.throw(ManifestMissing, /leaves the root/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not relax the hash check: an edited manifest is refused with the remap set', () => {
    writeFileSync(join(root, 'app.manifest.json'), JSON.stringify({ ...base, app: { ...base.app, name: 'edited' } }));
    expect(() => loadRuntimeManifest({ path: join(root, 'app.manifest.json'), mode: 'require' }, '/unrelated')).to.throw(/hash mismatch/);
  });

  it('verifies a manifest whose app.root was built elsewhere', () => {
    const m = moved();
    m.hash = hashManifest(m);
    writeFileSync(join(root, 'app.manifest.json'), JSON.stringify(m));
    expect(loadRuntimeManifest({ path: join(root, 'app.manifest.json'), mode: 'require' }, '/unrelated')?.app.root).to.equal('/built/elsewhere');
  });
});

describe('SPINAJS_PACKAGE_ROOTS', () => {
  const base = loadRuntimeManifest({ path: 'app.manifest.json', mode: 'prefer' }, FIX) as Manifest;
  let root: string;
  let prevRoot: string | undefined;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'spinajs-roots-')));
    prevRoot = process.env.SPINAJS_MANIFEST_ROOT;
    process.env.SPINAJS_MANIFEST_ROOT = root;
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: base.app.name, dependencies: { '@spinajs/dep': '0.0.0' } }));
  });

  afterEach(() => {
    delete process.env.SPINAJS_PACKAGE_ROOTS;
    if (prevRoot === undefined) delete process.env.SPINAJS_MANIFEST_ROOT;
    else process.env.SPINAJS_MANIFEST_ROOT = prevRoot;
    rmSync(root, { recursive: true, force: true });
  });

  const useMap = (map: Record<string, string>): void => {
    writeFileSync(join(root, 'package-roots.json'), JSON.stringify(map));
    process.env.SPINAJS_PACKAGE_ROOTS = join(root, 'package-roots.json');
  };
  const cmd = () => base.commands.find((c) => c.className === 'Cmd')!;

  it('locates a package under the app root through the map, with no node_modules', () => {
    mkdirSync(join(root, 'pkgs', 'dep'), { recursive: true });
    useMap({ '@spinajs/dep': 'pkgs/dep' });
    expect(packageRootOf('@spinajs/dep', base, '/unrelated')).to.equal(join(root, 'pkgs', 'dep'));
    expect(manifestFileFor(cmd(), base, '/unrelated')).to.equal(join(root, 'pkgs', 'dep', 'lib', 'cli', 'Cmd.js'));
    expect(isPackageSkipped('@spinajs/dep', base, '/unrelated', 'require')).to.equal(false);
  });

  it('without the variable the same layout is not found: a listed package is skipped, a direct dependency fails require', () => {
    mkdirSync(join(root, 'pkgs', 'dep'), { recursive: true });
    expect(isPackageSkipped('@spinajs/dep', base, '/unrelated', 'prefer')).to.equal(true);
    expect(() => isPackageSkipped('@spinajs/dep', base, '/unrelated', 'require')).to.throw(ManifestMissing, /not installed/);
  });

  it('treats a mapped package whose directory is missing as not installed', () => {
    useMap({ '@spinajs/dep': 'pkgs/dep' });
    expect(isPackageSkipped('@spinajs/dep', base, '/unrelated', 'prefer')).to.equal(true);
    expect(() => isPackageSkipped('@spinajs/dep', base, '/unrelated', 'require')).to.throw(ManifestMissing);
  });

  it('refuses a mapped root that leaves the app root', () => {
    useMap({ '@spinajs/dep': '../outside' });
    expect(() => packageRootOf('@spinajs/dep', base, '/unrelated')).to.throw(ManifestMissing, /leaves the root/);
    useMap({ '@spinajs/dep': resolve(tmpdir()) });
    expect(() => packageRootOf('@spinajs/dep', base, '/unrelated')).to.throw(ManifestMissing, /leaves the root/);
  });

  it('keeps file containment inside a mapped package', () => {
    mkdirSync(join(root, 'pkgs', 'dep'), { recursive: true });
    useMap({ '@spinajs/dep': 'pkgs/dep' });
    const escaping = { source: { file: 'src/../../../x.ts', line: 1, col: 1, package: '@spinajs/dep' } };
    expect(() => manifestFileFor(escaping, base, '/unrelated')).to.throw(ManifestMissing);
  });

  it('refuses a mapped directory that is a symlink to outside the app root', function () {
    const outside = mkdtempSync(join(tmpdir(), 'spinajs-roots-outside-'));
    try {
      try {
        symlinkSync(outside, join(root, 'linked'), 'junction');
      } catch {
        // Windows without developer mode or elevation cannot create links; the case runs on Linux and macOS CI
        this.skip();
      }
      useMap({ '@spinajs/dep': 'linked' });
      expect(() => packageRootOf('@spinajs/dep', base, '/unrelated')).to.throw(ManifestMissing, /leaves the root/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('names the file when the map is missing or not JSON', () => {
    process.env.SPINAJS_PACKAGE_ROOTS = join(root, 'nope.json');
    expect(() => packageRootOf('@spinajs/dep', base, '/unrelated')).to.throw(ManifestMissing, /SPINAJS_PACKAGE_ROOTS .*nope\.json cannot be read/);
    writeFileSync(join(root, 'bad.json'), '{');
    process.env.SPINAJS_PACKAGE_ROOTS = join(root, 'bad.json');
    expect(() => packageRootOf('@spinajs/dep', base, '/unrelated')).to.throw(ManifestMissing, /bad\.json cannot be read/);
  });

  it('does not read inherited keys of the map', () => {
    useMap({});
    expect(isPackageSkipped('constructor', { ...base, packages: [{ ...base.packages[0]!, name: 'constructor' }] }, '/unrelated', 'prefer')).to.equal(true);
  });

  it('rejects a map that is not an object of strings', () => {
    writeFileSync(join(root, 'package-roots.json'), JSON.stringify({ '@spinajs/dep': 1 }));
    process.env.SPINAJS_PACKAGE_ROOTS = join(root, 'package-roots.json');
    expect(() => packageRootOf('@spinajs/dep', base, '/unrelated')).to.throw(ManifestMissing, /package-roots/);
  });
});
