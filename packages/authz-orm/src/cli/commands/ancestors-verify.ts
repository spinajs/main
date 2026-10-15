import { Argument, Command } from '@spinajs/cli';

import { actualRows, diffRows, expectedRows, listedTypes, requireType } from '../../ancestors/full.js';
import { registeredTypes } from '../../registry.js';
import { AuthzOrmCliCommand } from '../base.js';

const MAX_LINES = 50;

@Command('authz:ancestors-verify', 'Compares authz_resource_ancestor with the @Parent columns; exit code 1 on any difference')
@Argument('type', false, 'resource type; default: every registered type and every type the table lists')
export class AncestorsVerifyCommand extends AuthzOrmCliCommand {
  public async execute(type?: string): Promise<void> {
    await this.command(
      () => (type === undefined ? undefined : [requireType(type)]),
      async (types) => {
        let failed = false;
        const all = types ?? [...new Set([...registeredTypes(), ...(await listedTypes(await this.driverFor(registeredTypes()[0] ?? '')))])];
        for (const t of all) {
          const driver = await this.driverFor(t);
          const d = diffRows(await expectedRows(driver, t), await actualRows(driver, t));
          const lines = [...d.missing.map((x) => `missing ${x}`), ...d.extra.map((x) => `extra ${x}`), ...d.depth.map((x) => `depth ${x}`)];
          if (lines.length === 0) {
            this.out(`${t}: ok`);
            continue;
          }
          failed = true;
          for (const l of lines.slice(0, MAX_LINES)) this.out(`${t}: ${l}`);
          if (lines.length > MAX_LINES) this.out(`${t}: … and ${lines.length - MAX_LINES} more`);
          this.out(`${t}: ${d.missing.length} missing, ${d.extra.length} extra, ${d.depth.length} wrong depth`);
        }
        if (failed) process.exitCode = 1;
      },
    );
  }
}
