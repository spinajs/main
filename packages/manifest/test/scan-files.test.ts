import { expect } from 'chai';
import 'mocha';
import { matchesMigrationGlob, migrationScanGlobs } from '../src/index.js';

describe('the migration filename rule', () => {
  // The compiler lists a `.mts` / `.cts` migration by its built name; the runtime filters the same entry by its source name.
  for (const ext of ['mts', 'cts']) {
    it(`admits a .${ext} migration under the environment it belongs to`, () => {
      expect(matchesMigrationGlob(`src/migrations/Foo_2026_07_29_10_00_00.${ext}`, 'prod')).to.equal(true);
      expect(matchesMigrationGlob(`src/migrations/Foo_2026_07_29_10_00_00.prod.${ext}`, 'prod')).to.equal(true);
      expect(matchesMigrationGlob(`src/migrations/Foo_2026_07_29_10_00_00.dev.${ext}`, 'prod')).to.equal(false);
      expect(matchesMigrationGlob(`src/migrations/Foo_2026_07_29_10_00_00.${ext}`)).to.equal(true);
    });

    it(`scans .${ext} files as the filename rule admits them`, () => {
      expect(migrationScanGlobs('prod').every((g) => g.includes(ext))).to.equal(true);
    });
  }
});
