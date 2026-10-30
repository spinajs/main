import 'mocha';
import { expect } from 'chai';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configFilesOf } from '../src/index.js';

describe('configFilesOf', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'spinajs-config-files-'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const write = (rel: string): void => {
    const file = join(root, 'src', 'config', rel);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '');
  };

  it('lists every built config file relative to the outDir, declarations and other files excluded', () => {
    for (const f of ['log.ts', 'log.production.ts', 'sub/db.cts', 'raw.json', 'types.d.ts', 'README.md']) write(f);
    expect(configFilesOf(root)).to.deep.equal(['config/log.js', 'config/log.production.js', 'config/raw.json', 'config/sub/db.cjs']);
  });

  it('is empty for a package without src/config', () => {
    expect(configFilesOf(root)).to.deep.equal([]);
  });
});
