import { Command } from '@spinajs/cli';

import { diffMemberships } from '../../membership/maintenance.js';
import { describeMembershipRow, MembershipCliCommand } from '../membership.js';

@Command('authz:membership-verify', 'Recomputes authz_subject_membership from the assignments; lists missing, extra and changed rows, exit code 1 on any')
export class MembershipVerifyCommand extends MembershipCliCommand {
  public async execute(): Promise<void> {
    await this.command(
      () => undefined,
      async () => {
        const diff = await diffMemberships({ ...(await this.membership()), now: new Date() });
        for (const r of diff.missing) this.out(`missing ${describeMembershipRow(r)}`);
        for (const r of diff.extra) this.out(`extra ${describeMembershipRow(r)}`);
        for (const c of diff.changed) this.out(`changed ${describeMembershipRow(c.stored)} -> ${describeMembershipRow(c.expected)}`);
        const n = diff.missing.length + diff.extra.length + diff.changed.length;
        if (n === 0) this.out('OK: authz_subject_membership matches the assignments');
        else this.fail(`${n} difference(s); run authz:membership-rebuild`);
      },
    );
  }
}
