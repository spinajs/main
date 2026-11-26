import 'mocha';
import { expect } from 'chai';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import tenancyOrmCli from '../src/config/tenancy-orm-cli.js';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The built files run in a process of their own: this one holds the src copy of the package, and once.ts refuses a second.
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

// What `spinajs tenant:rls` loads: the configuration, the built package and its command; the Orm boots inside execute().
// The command reads no row, so the table need not exist and the migration check is off.
const CLI_PROCESS = `
const { DI } = await import('@spinajs/di');
const { Configuration, FrameworkConfiguration } = await import('@spinajs/configuration');
const { Connection, Model, ModelBase, Orm } = await import('@spinajs/orm');
await import('@spinajs/log');
await import('@spinajs/orm-pglite');
class CliProcessConfiguration extends FrameworkConfiguration {
  constructor() { super(); this.Env = 'development'; }
  loadSources() { this.Sources = []; }
  onLoad() {
    return {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
      db: { MigrationCheck: 'off', StrictTableCheck: false, DefaultConnection: 'pg', Connections: [{ Driver: 'orm-driver-pglite', Filename: ':memory:', Name: 'pg' }] },
      tenancy: { orm: { rlsBypassRole: 'app' } },
    };
  }
}
DI.register(CliProcessConfiguration).as(Configuration);
await DI.resolve(Configuration);
const { Tenant } = await import('./lib/index.js');
class CliInvoice extends ModelBase {}
Connection('pg')(CliInvoice);
Model('cli_invoice')(CliInvoice);
Tenant({ rls: true })(CliInvoice);
const { TenantRlsCommand } = await import('./lib/cli/commands/tenant-rls.js');
const command = await DI.resolve(TenantRlsCommand);
await command.execute({ out: process.argv[1] });
await DI.get(Orm)?.dispose();
process.exit(0);
`;

describe('tenancy-orm cli discovery', function () {
  this.timeout(60_000);

  it('adds lib/cli/commands of @spinajs/tenancy-orm to system.dirs.cli', () => {
    const dirs = tenancyOrmCli.system.dirs.cli;
    expect(dirs).to.have.length(2);
    for (const d of dirs) expect(d.split(/[\\/]/).slice(-5)).to.deep.eq(['@spinajs', 'tenancy-orm', 'lib', 'cli', 'commands']);
  });

  it('finds tenant:rls as the first export of the built command files', () => {
    const dir = join(PKG_ROOT, 'lib', 'cli', 'commands');
    expect(existsSync(dir)).to.eq(true);
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', FIRST_EXPORTS, dir], { cwd: PKG_ROOT, encoding: 'utf8' });
    const commands = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as Record<string, string | null>;
    expect(Object.values(commands).map((n) => n?.split(' ')[0])).to.deep.eq(['tenant:rls']);
  });

  it('writes the migration in a process that loads only the built package and the command', () => {
    const out = mkdtempSync(join(tmpdir(), 'tenant-rls-cli-'));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.NODE_OPTIONS;
      const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', CLI_PROCESS, out], { cwd: PKG_ROOT, encoding: 'utf8', env });
      const files = readdirSync(out);
      expect(files).to.have.length(1);
      expect(stdout).to.include(`wrote ${join(out, files[0])}`).and.include('cli_invoice: restrictive policy on tenant_id, bypass role app');
      expect(readFileSync(join(out, files[0]), 'utf8')).to.include('@Migration("pg")').and.include('ALTER TABLE \\"cli_invoice\\" FORCE ROW LEVEL SECURITY');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
