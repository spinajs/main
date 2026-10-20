import { Argument, Command } from '@spinajs/cli';

import { expectedRows, requireType } from '../../ancestors/full.js';
import { AncestorRecord } from '../../ancestors/record.js';
import { registeredTypes } from '../../registry.js';
import { AuthzOrmCliCommand } from '../base.js';

@Command('authz:ancestors-rebuild', 'Rewrites authz_resource_ancestor from the @Parent columns, one transaction per type')
@Argument('type', false, 'resource type; default: every registered type')
export class AncestorsRebuildCommand extends AuthzOrmCliCommand {
  public async execute(type?: string): Promise<void> {
    await this.command(
      () => (type === undefined ? registeredTypes() : [requireType(type)]),
      async (types) => {
        for (const t of types) {
          const driver = this.driverFor(t);
          const rows = await expectedRows(driver, t);
          await driver.transaction(async () => {
            await AncestorRecord.destroy().where('resource_type', t);
            await AncestorRecord.insert(rows);
          });
          this.out(`${t}: ${rows.length} rows`);
        }
      },
    );
  }
}
