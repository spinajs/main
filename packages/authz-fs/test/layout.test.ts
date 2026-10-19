import * as chai from 'chai';
import 'mocha';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const expect = chai.expect;

const modules = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((f) => !f.endsWith('.map') && !f.endsWith('.d.ts')) : []);

describe('authz-fs package layout', () => {
  // Configuration loads every module under node_modules/@spinajs/*/lib/{mjs,cjs}/config as an app config file (D14), so only the db.Aliases fragment may sit there.
  it('ships nothing but the db.Aliases fragment in src/config or lib/*/config', () => {
    expect(modules(join(process.cwd(), 'src', 'config'))).to.deep.eq(['db.ts']);
    for (const flavour of ['mjs', 'cjs']) {
      const files = modules(join(process.cwd(), 'lib', flavour, 'config'));
      if (files.length > 0) expect(files, `lib/${flavour}/config`).to.deep.eq(['db.js']);
    }
  });
});
