import * as chai from 'chai';
import 'mocha';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const expect = chai.expect;

describe('authz-fs package layout', () => {
  // Configuration loads every module under node_modules/@spinajs/*/lib/config as an app config file (D14).
  it('ships no code modules in src/config or lib/config', () => {
    expect(existsSync(join(process.cwd(), 'src', 'config')), 'src/config').to.eq(false);
    expect(existsSync(join(process.cwd(), 'lib', 'config')), 'lib/config').to.eq(false);
  });
});
