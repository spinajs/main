import { GLOBAL, SYSTEM } from '@spinajs/authz';
import { Argument, Command, Option } from '@spinajs/cli';

import { parseExpiry, parseResourceRef, parseSubject, parseTagList, requireText } from '../args.js';
import { AuthzCliCommand } from '../base.js';

interface AssignOptions {
  scope?: string;
  expires?: string;
  tags?: string;
}

@Command('authz:assign', 'Assigns a role to a principal, at a scope (default: global)')
@Argument('subject', true, 'principal as <type>:<id>, e.g. user:<uuid>')
@Argument('role', true, 'role name')
@Option('-s, --scope <ref>', false, 'scope as <type>:<id>; default is global')
@Option('-e, --expires <iso>', false, 'ISO 8601 expiry date')
@Option('-t, --tags <list>', false, 'comma separated add-on tags')
export class AssignCommand extends AuthzCliCommand {
  public async execute(subject: string, role: string, options: AssignOptions = {}): Promise<void> {
    await this.command(
      () => ({
        subject: parseSubject(subject),
        role: requireText(role, 'role'),
        scope: options.scope === undefined ? GLOBAL : parseResourceRef(options.scope),
        ...(options.tags === undefined ? {} : { tags: parseTagList(options.tags) }),
        ...(options.expires === undefined ? {} : { expiresAt: parseExpiry(options.expires) }),
      }),
      async (assignment) => {
        const created = await (await this.admin()).assign(SYSTEM, assignment, { reason: 'cli' });
        this.out(created.id);
      },
    );
  }
}
