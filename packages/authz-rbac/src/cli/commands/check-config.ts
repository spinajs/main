import { Command, Option } from '@spinajs/cli';
import { Configuration } from '@spinajs/configuration';
import { Autoinject } from '@spinajs/di';

import { RoleStore } from '../../contracts.js';
import type { GrantDef } from '../../contracts.js';
import { RBAC_SERVICE_NAME } from '../../host/register.js';
// Registers ConfigRoleStore by name: the CLI loads only the command modules.
import { rbacStoreNames } from '../../stores/index.js';
import { CliUsageError } from '../args.js';
import { AuthzCliCommand } from '../base.js';

interface CheckConfigOptions {
  explainRole?: string;
}

/** The RBAC model's service, resolved by DI name: its class is not part of the frozen contracts. */
export interface RbacGrants {
  grantsOf(role: string): readonly GrantDef[] | Promise<readonly GrantDef[]>;
}

const grantLine = (g: GrantDef): string => {
  const parts = [g.permission];
  if (g.relation !== undefined) parts.push(`relation=${[g.relation].flat().join('|')}`);
  if (g.on) parts.push(`on=${g.on.map((p) => (p.id === undefined ? p.type : `${p.type}:${p.id}`)).join(',')}`);
  if (g.fields) parts.push(`fields=${JSON.stringify(g.fields)}`);
  if (g.requiresTag) parts.push(`requiresTag=${g.requiresTag}`);
  if (g.grantedAt) parts.push(`grantedAt=${g.grantedAt.join(',')}`);
  return parts.join('  ');
};

@Command('authz:check-config', 'Validates the authz configuration; optionally lists the grants of a role')
@Option('--explain-role <role>', false, 'list the effective grants of a role')
export class CheckConfigCommand extends AuthzCliCommand {
  public Roles?: RoleStore;
  public Rbac?: RbacGrants;

  @Autoinject(Configuration)
  public Configuration: Configuration;

  public async execute(options: CheckConfigOptions = {}): Promise<void> {
    await this.command(
      () => options,
      async (o) => {
        // Resolving the service runs the boot validation.
        await this.authz();
        const roles: { name: string }[] = [];
        let ladders = 0;
        for (const store of await this.roleStores()) {
          const loaded = await store.load();
          roles.push(...loaded.roles);
          ladders += loaded.ladders.length;
        }
        this.out(`OK: ${roles.length} role(s), ${ladders} ladder(s)`);

        if (o.explainRole !== undefined) await this.explainRole(o.explainRole, roles);
      },
    );
  }

  /** The RoleStores the app registers, else the stores `authz.rbac.stores.roles` names (default ConfigRoleStore). */
  private async roleStores(): Promise<readonly RoleStore[]> {
    if (this.Roles) return [this.Roles];
    const container = this.Container;
    if (container.hasRegistered(RoleStore)) return (await container.resolve(Array.chainOf(RoleStore))) as RoleStore[];

    const names = rbacStoreNames(this.Configuration, 'roles');
    const missing = names.filter((n) => !container.hasRegistered(n));
    if (missing.length > 0) throw new CliUsageError(`no role store registered under ${missing.join(', ')} (authz.rbac.stores.roles): is @spinajs/authz-rbac loaded?`);
    return Promise.all(names.map((n) => container.resolve<RoleStore>(n)));
  }

  private async explainRole(role: string, known: ReadonlyArray<{ name: string }>): Promise<void> {
    if (!known.some((r) => r.name === role)) throw new CliUsageError(`unknown role ${JSON.stringify(role)}`);
    // A value registration lives in the cache, not the registry.
    const registered = this.Container.hasRegistered(RBAC_SERVICE_NAME) || this.Container.isResolved(RBAC_SERVICE_NAME);
    const rbac = this.Rbac ?? (registered ? await this.Container.resolve<RbacGrants>(RBAC_SERVICE_NAME) : undefined);
    if (!rbac) throw new CliUsageError('the RBAC model (@spinajs/authz-rbac model) is not registered: nothing to explain');

    const grants = await rbac.grantsOf(role);
    this.out(`role ${role}: ${grants.length} effective grant(s)`);
    for (const g of grants) this.out(`  ${grantLine(g)}`);
  }
}
