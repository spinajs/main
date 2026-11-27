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
// The defaults of an application, over a database nobody migrated: the migration of the new model is pending.
const CLI_PROCESS = `
const { DI } = await import('@spinajs/di');
const { Configuration, FrameworkConfiguration } = await import('@spinajs/configuration');
const { Connection, Migration, Model, ModelBase, Orm, OrmMigration } = await import('@spinajs/orm');
await import('@spinajs/log');
await import('@spinajs/orm-pglite');
class CliProcessConfiguration extends FrameworkConfiguration {
  constructor() { super(); this.Env = 'development'; }
  loadSources() { this.Sources = []; }
  onLoad() {
    return {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
      db: { DefaultConnection: 'pg', Connections: [{ Driver: 'orm-driver-pglite', Filename: process.argv[2], Name: 'pg' }] },
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
class CliInvoice_2026_01_01_00_00_00 extends OrmMigration {
  async up(connection) { await connection.schema().createTable('cli_invoice', (table) => table.string('tenant_id', 64)); }
  async down(connection) { await connection.schema().dropTable('cli_invoice'); }
}
Migration('pg')(CliInvoice_2026_01_01_00_00_00);
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

  /** Runs the command in a process of its own over the PGlite database `data`, and returns the file it wrote to `out`. */
  function runCli(out: string, data: string): { stdout: string; file: string } {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NODE_OPTIONS;
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', CLI_PROCESS, out, data], { cwd: PKG_ROOT, encoding: 'utf8', env });
    const files = readdirSync(out);
    expect(files).to.have.length(1);
    return { stdout, file: join(out, files[0]) };
  }

  const scratch = (): string => mkdtempSync(join(tmpdir(), 'tenant-rls-cli-'));

  it('writes the migration in a process that loads only the built package and the command', () => {
    const out = scratch();
    try {
      const { stdout, file } = runCli(out, ':memory:');
      expect(stdout).to.include(`wrote ${file}`).and.include('cli_invoice: restrictive policy on tenant_id, bypass role app');
      expect(readFileSync(file, 'utf8')).to.include('@Migration("pg")').and.include('ALTER TABLE \\"cli_invoice\\" FORCE ROW LEVEL SECURITY');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('runs again over the same database before anything was migrated', () => {
    const dirs = [scratch(), scratch(), scratch()];
    const [data, first, second] = dirs;
    try {
      runCli(first, data);
      const { stdout, file } = runCli(second, data);
      expect(stdout).to.include(`wrote ${file}`);
    } finally {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    }
  });
});
