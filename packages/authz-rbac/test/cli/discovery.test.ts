import { META_COMMAND } from '@spinajs/cli';
import { expect } from 'chai';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import 'mocha';

import rbacCli from '../../src/config/rbac-cli.js';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('authz cli discovery', function () {
  this.timeout(30000);
  it('adds lib/<mjs|cjs>/cli/commands of @spinajs/authz-rbac to system.dirs.cli', () => {
    const dirs = rbacCli.system.dirs.cli;
    expect(dirs).to.have.length(2);
    for (const d of dirs) expect(d.split(/[\\/]/).slice(-6)).to.deep.equal(['@spinajs', 'authz-rbac', 'lib', 'mjs', 'cli', 'commands']);
  });

  it('finds exactly the four commands: the first export of every built file is a command', async () => {
    const dir = join(PKG_ROOT, 'lib', 'mjs', 'cli', 'commands');
    expect(existsSync(dir)).to.equal(true);
    const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
    const names: string[] = [];
    for (const f of files) {
      const first = Object.values(await import(pathToFileURL(join(dir, f)).href))[0] as object;
      const meta = Reflect.getMetadata(META_COMMAND, first) as { nameAndArgs: string } | undefined;
      expect(meta, f).to.not.equal(undefined);
      names.push(meta!.nameAndArgs.split(' ')[0]);
    }
    expect(names.sort()).to.deep.equal(['authz:assign', 'authz:check-config', 'authz:explain', 'authz:revoke']);
  });
});
