import { Command, Option } from '@spinajs/cli';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { RoleStore } from '../../contracts.js';
import type { GrantDef } from '../../contracts.js';
// Registers ConfigRoleStore: the CLI loads only the command modules. Once the RBAC model (src/model) and the
// admin handlers (src/admin) exist, import their barrels here too.
import '../../stores/index.js';
import { CliUsageError } from '../args.js';
import { AuthzCliCommand } from '../base.js';

interface CheckConfigOptions {
  explainRole?: string;
  unattended?: boolean;
}

/** The RBAC model's service, resolved by DI name: its class is not part of the frozen contracts. */
export interface RbacGrants {
  grantsOf(role: string): readonly GrantDef[] | Promise<readonly GrantDef[]>;
}

const RBAC_SERVICE = 'RbacService';
const AUDIT_TABLE = 'authz_audit';

// resourceKey() escapes ':', '/' and '%' in the type part, so the first ':' ends the type.
const typeOf = (resource: unknown): string => {
  if (typeof resource !== 'string' || resource === '') return '(none)';
  const type = resource.split(':', 1)[0];
  try {
    return decodeURIComponent(type);
  } catch {
    return type;
  }
};

const grantLine = (g: GrantDef): string => {
  const parts = [g.permission];
  if (g.relation !== undefined) parts.push(`relation=${[g.relation].flat().join('|')}`);
  if (g.on) parts.push(`on=${g.on.map((p) => (p.id === undefined ? p.type : `${p.type}:${p.id}`)).join(',')}`);
  if (g.fields) parts.push(`fields=${JSON.stringify(g.fields)}`);
  if (g.requiresTag) parts.push(`requiresTag=${g.requiresTag}`);
  if (g.grantedAt) parts.push(`grantedAt=${g.grantedAt.join(',')}`);
  return parts.join('  ');
};

@Command('authz:check-config', 'Validates the authz configuration; optionally lists the grants of a role or unattended queries')
@Option('--explain-role <role>', false, 'list the effective grants of a role')
@Option('--unattended', false, 'list resource types queried without a principal (from the audit log)')
export class CheckConfigCommand extends AuthzCliCommand {
  public Roles?: RoleStore;
  public Rbac?: RbacGrants;
  public Orm?: Orm;
  public Configuration?: Configuration;

  public async execute(options: CheckConfigOptions = {}): Promise<void> {
    await this.command(
      () => options,
      async (o) => {
        // Resolving the service runs the boot validation.
        await this.authz();
        const { roles, ladders } = await (await this.roleStore()).load();
        this.out(`OK: ${roles.length} role(s), ${ladders.length} ladder(s)`);

        if (o.explainRole !== undefined) await this.explainRole(o.explainRole, roles);
        if (o.unattended) await this.unattended();
      },
    );
  }

  private async roleStore(): Promise<RoleStore> {
    if (this.Roles) return this.Roles;
    if (!DI.RootContainer.hasRegistered(RoleStore)) throw new CliUsageError('no RoleStore registered: is @spinajs/authz-rbac loaded?');
    return (this.Roles = await DI.resolve(RoleStore));
  }

  private async explainRole(role: string, known: ReadonlyArray<{ name: string }>): Promise<void> {
    if (!known.some((r) => r.name === role)) throw new CliUsageError(`unknown role ${JSON.stringify(role)}`);
    // A value registration lives in the cache, not the registry.
    const registered = DI.RootContainer.hasRegistered(RBAC_SERVICE) || DI.RootContainer.isResolved(RBAC_SERVICE);
    const rbac = this.Rbac ?? (registered ? await DI.resolve<RbacGrants>(RBAC_SERVICE) : undefined);
    if (!rbac) throw new CliUsageError('the RBAC model (@spinajs/authz-rbac model) is not registered: nothing to explain');

    const grants = await rbac.grantsOf(role);
    this.out(`role ${role}: ${grants.length} effective grant(s)`);
    for (const g of grants) this.out(`  ${grantLine(g)}`);
  }

  private async unattended(): Promise<void> {
    const orm = (this.Orm ??= await DI.resolve(Orm));
    const connection = (this.Configuration ??= await DI.resolve(Configuration)).get<string | undefined>('authz.rbac.connection', undefined);
    const driver: OrmDriver | undefined = orm.Connections.get(connection ?? 'default');
    if (!driver) throw new CliUsageError(`no ORM connection ${JSON.stringify(connection ?? 'default')}`);
    if (!(await driver.schema().tableExists(AUDIT_TABLE))) throw new CliUsageError(`the ${AUDIT_TABLE} table does not exist: DbDecisionAudit (authz-orm) is not enabled`);

    const rows = (await driver.select().from(AUDIT_TABLE).where('reason', 'unattended').columns(['resource'])) as unknown as Array<{ resource: unknown }>;
    const counts = new Map<string, number>();
    for (const r of rows) {
      const type = typeOf(r.resource);
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }

    if (counts.size === 0) {
      this.out('no unattended queries in the audit log');
      return;
    }
    this.out('resource types queried without a principal:');
    for (const [type, n] of [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) this.out(`  ${type}  ${n}`);
  }
}
