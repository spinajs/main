import { Command, Option } from '@spinajs/cli';

import { rebuildMemberships } from '../../membership/maintenance.js';
import { MembershipCliCommand } from '../membership.js';

@Command('authz:membership-rebuild', 'Rewrites authz_subject_membership from the assignments in one transaction')
@Option('-d, --domain <name>', false, 'the authz domain whose authz_version is bumped; default root')
export class MembershipRebuildCommand extends MembershipCliCommand {
  public async execute(options: { domain?: string } = {}): Promise<void> {
    await this.command(
      () => ({ domain: options.domain ?? 'root' }),
      async ({ domain }) => {
        const m = await this.membership();
        const written = await m.backend.transaction(domain, async (tx) => {
          const n = await rebuildMemberships({ ...m, now: new Date() }, tx);
          await m.backend.bumpVersion(domain, tx);
          return n;
        });
        this.out(`${written} membership row(s) written; running apps drop cached decisions when their caches expire or restart`);
      },
    );
  }
}
