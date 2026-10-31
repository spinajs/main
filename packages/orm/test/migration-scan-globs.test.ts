import { expect } from 'chai';
import 'mocha';
import glob from 'glob';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { matchesMigrationGlob, migrationScanGlobs } from '@spinajs/manifest';

const FILES = [
  'Foo.ts', 'Foo.js', 'Foo.cjs', 'Foo.mjs', 'Foo.mts', 'Foo.json', 'Foo.d.ts', '.hidden.ts', 'legacy.old.ts', 'helper.util.ts', 'a.b.prod.ts', 'a.prod.cjs', 'x.production.ts',
  'Foo_2026_07_29_10_00_00.ts', 'Foo_2026_07_29_10_00_00.prod.ts', 'Foo_2026_07_29_10_00_00.test.ts', 'Foo_2026_07_29_10_00_00.spec.js', 'Foo_2026_07_29_10_00_00.d.ts',
];

describe('the filename rule of a migration scan', () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'spinajs-migration-globs-'));
    for (const file of FILES) writeFileSync(join(dir, file), '');
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  for (const env of ['prod', 'test', 'dev', 'old', 'util', 'spec', 'd']) {
    it(`gives the same files as the globs themselves under ${env}`, () => {
      const found = migrationScanGlobs(env).flatMap((p) => glob.sync(join(dir, p).replace(/\\/g, '/'))).map((f) => basename(f));
      expect(FILES.filter((f) => matchesMigrationGlob(f, env)).sort()).to.deep.equal([...new Set(found)].sort());
    });
  }

  it('keeps every file some environment can match when the environment is not known yet', () => {
    expect(FILES.filter((f) => matchesMigrationGlob(f))).to.include.members(['legacy.old.ts', 'Foo.ts', 'Foo_2026_07_29_10_00_00.test.ts']);
    expect(FILES.filter((f) => matchesMigrationGlob(f))).to.not.include.members(['Foo.json', 'Foo.mts', '.hidden.ts']);
  });

  it('reads only the name, not a dotted folder above it', () => {
    expect(matchesMigrationGlob('C:\\my.app\\v1.2\\Foo.ts', 'prod')).to.equal(true);
    expect(matchesMigrationGlob('/my.app/v1.2/Foo.ts', 'prod')).to.equal(true);
  });
});
