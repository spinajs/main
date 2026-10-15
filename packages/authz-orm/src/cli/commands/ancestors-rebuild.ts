import { Argument, Command } from '@spinajs/cli';

import { expectedRows, requireType } from '../../ancestors/full.js';
import { AUTHZ_RESOURCE_ANCESTOR_TABLE, ROW_CHUNK, chunks } from '../../ancestors/table.js';
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
            for (const part of chunks(rows, ROW_CHUNK)) await driver.insert().into(AUTHZ_RESOURCE_ANCESTOR_TABLE).values(part);
          });
          this.out(`${t}: ${rows.length} rows`);
        }
      },
    );
  }
}
