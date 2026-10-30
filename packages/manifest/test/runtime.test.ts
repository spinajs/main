import 'mocha';
import { expect } from 'chai';
import { resolve } from 'node:path';
import { loadRuntimeManifest, manifestFileFor, ManifestMissing, packageRootOf } from '../src/runtime.js';
import type { Manifest } from '../src/index.js';

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
});
