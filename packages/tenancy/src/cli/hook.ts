import { Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { CliCommandHook } from '@spinajs/cli';
import type { CliHookCommand, IOption } from '@spinajs/cli';
// Through the package entry: a CLI process may load nothing else of this package, and the entry registers the registries.
import { admitTenant, allTenantsScope, tenantScopeOf } from '../index.js';
import { establishTenantScope } from '../scope.js';

/** Below the default order: a hook of another package runs inside the tenant the command names. */
export const TENANT_CLI_HOOK_ORDER = -100;

const OPTIONS: readonly IOption[] = [
  { flags: '--tenant <id>', description: 'Run the command inside this tenant', conflicts: 'allTenants' },
  { flags: '--all-tenants <reason>', description: 'Run the command across all tenants; the reason is logged', conflicts: 'tenant' },
];

/** `--tenant <id>` runs a command inside that tenant, `--all-tenants <reason>` across all of them, neither with no tenant scope. */
@Injectable(CliCommandHook)
export class TenantCliHook extends CliCommandHook {
  public override readonly order: number = TENANT_CLI_HOOK_ORDER;

  @Logger('tenancy')
  protected Log: Log;

  public override options(): readonly IOption[] {
    return OPTIONS;
  }

  // The scope is always replaced: a process that embeds the CLI may resolve it inside a scope of its own.
  public async aroundExecute<T>(command: CliHookCommand, next: () => Promise<T>): Promise<T> {
    const { tenant, allTenants } = command.options;
    if (typeof tenant === 'string') {
      const record = await admitTenant(tenant);
      return establishTenantScope(tenantScopeOf(record.id), next);
    }
    if (typeof allTenants === 'string') {
      const scope = allTenantsScope(allTenants);
      this.Log.info({ command: command.name, reason: allTenants.trim() }, 'Command ${command} runs across all tenants: ${reason}');
      return establishTenantScope(scope, next);
    }
    return establishTenantScope(undefined, next);
  }
}
