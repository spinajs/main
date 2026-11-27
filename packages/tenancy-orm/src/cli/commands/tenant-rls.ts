import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { CliCommand, Command, Option } from '@spinajs/cli';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { IOFail, InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { resolveMigrationTool } from '@spinajs/orm';
import type { Orm } from '@spinajs/orm';

import { generateTenantRls, tenantRlsMigrationSource, tenantRlsTables } from '../../rls.js';
import type { TenantRlsTable } from '../../rls.js';
import { speaksPostgres } from '../../session.js';

interface TenantRlsCommandOptions {
  readonly out: string;
  readonly bypassRole?: string;
}

const stamp = (d: Date): string => d.toISOString().slice(0, 19).replace(/[-:T]/g, '_');

function configuredBypassRole(): string | undefined {
  const value = DI.get(Configuration)?.get<unknown>(['tenancy', 'orm', 'rlsBypassRole']);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function byConnection(orm: Orm, tables: readonly TenantRlsTable[]): Map<string, TenantRlsTable[]> {
  const out = new Map<string, TenantRlsTable[]>();
  for (const t of tables) {
    const driver = orm.Connections.get(t.connection);
    if (driver === undefined || !speaksPostgres(driver)) {
      throw new InvalidOperation(`tenant:rls: ${t.table} is on connection ${t.connection}, which is not PostgreSQL; row level security needs PostgreSQL or PGlite, set rls: false on its model`);
    }
    out.set(t.connection, [...(out.get(t.connection) ?? []), t]);
  }
  return out;
}

/** Boots the Orm as a migration tool, so neither a pending migration nor a missing table stops it. */
@Command('tenant:rls', 'Writes a migration with the PostgreSQL row level security of every row-mode @Tenant({ rls: true }) table')
@Option('-o, --out <dir>', true, 'directory the migration is written to')
@Option('--bypass-role <role>', false, 'database role the all-tenants scope lets through; default tenancy.orm.rlsBypassRole')
export class TenantRlsCommand extends CliCommand {
  /** Tests set it; otherwise the command resolves the Orm. */
  public Orm?: Orm;

  public Print: (line: string) => void = (line) => console.log(line);

  public Now: () => Date = () => new Date();

  public async execute(options: TenantRlsCommandOptions): Promise<void> {
    if (options.bypassRole?.trim() === '') throw new InvalidArgument('tenant:rls: --bypass-role is empty; name the database role the all-tenants scope lets through, or leave the option out');
    const orm = this.Orm ?? (await resolveMigrationTool()).Orm;
    const groups = byConnection(orm, tenantRlsTables());
    if (groups.size === 0) throw new InvalidOperation('tenant:rls: no row-mode tenant model declares rls (@Tenant({ rls: true }) or tenancy.orm.rls: true)');
    const bypassRole = options.bypassRole ?? configuredBypassRole();
    const out = resolve(options.out);
    const at = stamp(this.Now());
    await mkdir(out, { recursive: true });
    for (const [connection, tables] of groups) {
      const name = `TenantRls_${at}${groups.size > 1 ? `_${connection.replace(/[^A-Za-z0-9_]/g, '_')}` : ''}`;
      const file = join(out, `${name}.ts`);
      const source = tenantRlsMigrationSource(generateTenantRls(tables, bypassRole === undefined ? {} : { bypassRole }), name, connection);
      try {
        // 'wx': two runs in one second produce the same class name, and the first file must survive
        await writeFile(file, source, { flag: 'wx' });
      } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'EEXIST') throw new IOFail(`tenant:rls: migration file ${file} already exists - it was generated in the same second; run the command again`, err);
        throw err;
      }
      this.Print(`wrote ${file}`);
      for (const t of tables) this.Print(`  ${t.table}: restrictive policy on ${t.column}${bypassRole === undefined ? ', no bypass role' : `, bypass role ${bypassRole}`}`);
    }
  }
}
