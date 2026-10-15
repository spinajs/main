import { expect } from 'chai';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'mocha';

import ormCli from '../../src/config/authz-orm-cli.js';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The built files run in their own process: this one already holds the src copy of the package, and
// its once.ts guard refuses a second copy.
const FIRST_EXPORTS = `
import { META_COMMAND } from '@spinajs/cli';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = process.argv[1];
const out = {};
for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
  const first = Object.values(await import(pathToFileURL(join(dir, f)).href))[0];
  out[f] = Reflect.getMetadata(META_COMMAND, first)?.nameAndArgs ?? null;
}
console.log(JSON.stringify(out));
`;

describe('authz-orm cli discovery', function () {
  this.timeout(30000);

  it('adds lib/<mjs|cjs>/cli/commands of @spinajs/authz-orm to system.dirs.cli', () => {
    const dirs = ormCli.system.dirs.cli;
    expect(dirs).to.have.length(2);
    for (const d of dirs) expect(d.split(/[\\/]/).slice(-6)).to.deep.equal(['@spinajs', 'authz-orm', 'lib', 'mjs', 'cli', 'commands']);
  });

  it('finds exactly the two commands: the first export of every built file is a command', () => {
    const dir = join(PKG_ROOT, 'lib', 'mjs', 'cli', 'commands');
    expect(existsSync(dir)).to.equal(true);
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', FIRST_EXPORTS, dir], { cwd: PKG_ROOT, encoding: 'utf8' });
    const commands = JSON.parse(stdout.trim().split('\n').pop()!) as Record<string, string | null>;
    for (const [f, nameAndArgs] of Object.entries(commands)) expect(nameAndArgs, f).to.be.a('string');
    expect(Object.values(commands).map((n) => n!.split(' ')[0]).sort()).to.deep.equal(['authz:ancestors-rebuild', 'authz:ancestors-verify']);
  });
});
