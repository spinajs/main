import { AuthzConfigError } from '@spinajs/authz';
import { Argument, Command, Option } from '@spinajs/cli';

import { ancestorTypesOf, expectedRows, requireType, undeclaredAncestorTypes, undeclaredLinks } from '../../ancestors/full.js';
import { AncestorRecord } from '../../ancestors/record.js';
import { lockForRebuild, rebuildLockError } from '../../ancestors/rebuild-lock.js';
import { registeredTypes } from '../../registry.js';
import { AuthzOrmCliCommand } from '../base.js';

interface RebuildOptions {
  readonly prune?: boolean;
}

@Command('authz:ancestors-rebuild', 'Rewrites authz_resource_ancestor from the @Parent columns, one transaction per type')
@Argument('type', false, 'resource type; default: every registered type')
@Option('--prune', false, 'also delete links to ancestor types no @Parent of the type names in this process; for a type no model declares, its rows')
export class AncestorsRebuildCommand extends AuthzOrmCliCommand {
  public async execute(type?: string, options: RebuildOptions = {}): Promise<void> {
    const prune = options.prune === true;
    await this.command(
      () => (type === undefined ? registeredTypes() : [prune ? type : requireType(type)]),
      async (types) => {
        // Refuses a type on another connection than the table before the check below reads the table.
        const drivers = new Map(types.map((t) => [t, this.driverFor(t)]));
        const refuseUndeclared = async (t: string): Promise<void> => {
          const undeclared = undeclaredAncestorTypes(t, await ancestorTypesOf(t));
          if (undeclared.length > 0) throw new AuthzConfigError(`${t}: ${undeclaredLinks(t, undeclared)}`);
        };
        // Every type is checked before any is rewritten: a parent whose module this process did not load is not dropped.
        if (!prune) for (const t of types) await refuseUndeclared(t);
        for (const [t, driver] of drivers) {
          const count = await driver
            .transaction(async () => {
              await lockForRebuild(driver, t);
              // Again under the lock: another process may have written such a link since the check above.
              if (!prune) await refuseUndeclared(t);
              const rows = await expectedRows(driver, t);
              await AncestorRecord.destroy().where('resource_type', t);
              if (rows.length > 0) await AncestorRecord.insert(rows);
              return rows.length;
            })
            .catch((e: unknown) => {
              throw rebuildLockError(t, e);
            });
          this.out(`${t}: ${count} rows`);
        }
      },
    );
  }
}
