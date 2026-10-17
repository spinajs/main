import { Argument, Command } from '@spinajs/cli';
import { insertChunked } from '@spinajs/orm';

import { expectedRows, requireType } from '../../ancestors/full.js';
import { AUTHZ_RESOURCE_ANCESTOR_TABLE, ROW_CHUNK } from '../../ancestors/table.js';
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
          const driver = await this.driverFor(t);
          const rows = await expectedRows(driver, t);
          await driver.transaction(async () => {
            await driver.del().from(AUTHZ_RESOURCE_ANCESTOR_TABLE).where('resource_type', t);
            await insertChunked(driver, AUTHZ_RESOURCE_ANCESTOR_TABLE, rows, ROW_CHUNK);
          });
          this.out(`${t}: ${rows.length} rows`);
        }
      },
    );
  }
}
