import 'mocha';
import { expect } from 'chai';
import glob from 'glob';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { matchesScanGlob } from '@spinajs/manifest';
import { SCAN_GLOB } from '../src/index.js';

const FILES = ['a.ts', 'a.js', 'a.test.ts', 'a.test.js', 'a.d.ts', 'a.d.js', 'a.json', 'a.mts', 'a.mjs', 'a.cjs', 'a.ts.map', '.hidden.ts', 'd.ts'];

describe('the filename rule of a directory scan', () => {
  it('gives the same files as the glob itself', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spinajs-scan-glob-'));
    try {
      for (const file of FILES) writeFileSync(join(dir, file), '');
      const found = glob.sync(join(dir, SCAN_GLOB).replace(/\\/g, '/')).map((f) => basename(f));
      expect(FILES.filter((f) => matchesScanGlob(f)).sort()).to.deep.equal([...found].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
