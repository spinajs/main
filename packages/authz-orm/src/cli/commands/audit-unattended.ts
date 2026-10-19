import { Command } from '@spinajs/cli';

import { AUDIT_CONNECTION, AUDIT_TABLE } from '../../audit/names.js';
import { AuthzOrmCliCommand } from '../base.js';

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

@Command('authz:audit-unattended', 'Lists the resource types queried without a principal, from the authz_audit table of DbDecisionAudit')
export class AuditUnattendedCommand extends AuthzOrmCliCommand {
  public async execute(): Promise<void> {
    await this.command(
      () => undefined,
      async () => {
        const driver = (await this.orm()).Connections.get(AUDIT_CONNECTION);
        if (!driver) throw new Error(`authz:audit-unattended: the ORM has no connection ${JSON.stringify(AUDIT_CONNECTION)}; map it to the audit database with db.Aliases`);
        if (!(await driver.schema().tableExists(AUDIT_TABLE))) throw new Error(`authz:audit-unattended: the ${AUDIT_TABLE} table does not exist: DbDecisionAudit is not enabled`);

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
      },
    );
  }
}
