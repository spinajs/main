import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { AuthzDomains, parsePermission } from '@spinajs/authz';
import type { PermissionDef } from '@spinajs/authz';
import { Command, Option } from '@spinajs/cli';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';

import { ormDomain } from '../../host.js';
import { planTermCompilers } from '../../lists/terms.js';
import { generateRls, rlsMigrationSource } from '../../rls/generate.js';
import type { RlsOutput } from '../../rls/generate.js';
import { rlsResources } from '../../rls/resources.js';
import { rlsPlanSources } from '../../rls/source.js';
import { AuthzOrmCliCommand } from '../base.js';

interface RlsOptions {
  readonly out: string;
  readonly domain?: string;
  readonly bypassRole?: string;
}

/** `type:action` as the models see it; a permission no model applies to plans nothing, so its policy is FALSE. */
const permissionOf = (name: string): PermissionDef => {
  const { resource, action } = parsePermission(name);
  return { name, resource, action, types: [resource], source: 'authz:rls' };
};

const stamp = (d: Date): string => d.toISOString().slice(0, 19).replace(/[-:T]/g, '_');

@Command('authz:rls', 'Writes a migration with the Postgres row level security of every @AccessResource(type, { rls }) table, from the list plans')
@Option('-o, --out <dir>', true, 'directory the migration is written to')
@Option('--domain <name>', false, 'authz domain whose models plan the policies; default authz.orm.domain')
@Option('--bypass-role <role>', false, 'database role SYSTEM connects as, the only one spina.bypass lets through; default authz.orm.rls.bypassRole')
export class RlsCommand extends AuthzOrmCliCommand {
  public async execute(options: RlsOptions): Promise<void> {
    await this.command(
      () => ({ out: resolve(options.out), domain: options.domain ?? ormDomain(), bypassRole: options.bypassRole ?? this.configuredBypassRole() }),
      async ({ out, domain, bypassRole }) => {
        const service = await (await this.Container.resolve(AuthzDomains)).service(domain);
        const byConnection = new Map<string, ReturnType<typeof rlsResources>>();
        for (const r of rlsResources()) byConnection.set(r.connection ?? 'default', [...(byConnection.get(r.connection ?? 'default') ?? []), r]);
        if (byConnection.size === 0) throw new Error('authz:rls: no @AccessResource(type, { rls }) model is registered');
        const at = new Date();
        for (const [connection, resources] of byConnection) {
          const output = await generateRls({ models: service.models(), permissions: { get: permissionOf }, resources: resources.map((r) => r.resource), sources: rlsPlanSources(), compilers: planTermCompilers(), ...(bypassRole ? { bypassRole } : {}) });
          if (!this.report(output)) throw new Error('authz:rls: AUTHZ020, nothing written; fix the policies or set rls: \'partial\'');
          const name = `AuthzRls_${stamp(at)}${byConnection.size > 1 ? `_${connection.replace(/[^A-Za-z0-9_]/g, '_')}` : ''}`;
          await mkdir(out, { recursive: true });
          await writeFile(join(out, `${name}.ts`), rlsMigrationSource(output, name, connection));
          this.out(`wrote ${join(out, `${name}.ts`)}`);
          for (const r of resources) this.out(`  ${r.resource.table}: ENABLE + FORCE ROW LEVEL SECURITY (${r.resource.type})`);
        }
      },
    );
  }

  private configuredBypassRole(): string | undefined {
    const v = DI.get(Configuration)?.get<unknown>(['authz', 'orm', 'rls', 'bypassRole']);
    return typeof v === 'string' && v !== '' ? v : undefined;
  }

  /** Prints the diagnostics; false when one is an error. */
  private report(output: RlsOutput): boolean {
    for (const d of output.diagnostics) this.out(`${d.severity} ${d.code} ${d.message}`);
    return !output.diagnostics.some((d) => d.severity === 'error');
  }
}
