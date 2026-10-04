import { GLOBAL, SYSTEM } from '@spinajs/authz';
import { Argument, Command, Option } from '@spinajs/cli';

import { CliUsageError, parseResourceRef, parseSubject, requireText } from '../args.js';
import { AuthzCliCommand } from '../base.js';

interface RevokeOptions {
  scope?: string;
  id?: string;
}

@Command('authz:revoke', 'Revokes a role from a principal at a scope, or one assignment by id')
@Argument('subject', false, 'principal as <type>:<id>')
@Argument('role', false, 'role name')
@Option('-s, --scope <ref>', false, 'scope as <type>:<id>; default is global')
@Option('--id <id>', false, 'revoke this assignment id instead of subject and role')
export class RevokeCommand extends AuthzCliCommand {
  public async execute(subject?: string, role?: string, options: RevokeOptions = {}): Promise<void> {
    await this.command(
      () => {
        if (options.id !== undefined) {
          if (subject !== undefined || role !== undefined || options.scope !== undefined) throw new CliUsageError('--id cannot be combined with a subject, role or --scope');
          return { kind: 'id' as const, id: requireText(options.id, '--id') };
        }
        if (subject === undefined || role === undefined) throw new CliUsageError('give <subject> <role>, or --id <id>');
        return { kind: 'where' as const, subject: parseSubject(subject), role: requireText(role, 'role'), scope: options.scope === undefined ? GLOBAL : parseResourceRef(options.scope) };
      },
      async (target) => {
        const admin = await this.admin();
        if (target.kind === 'id') {
          await admin.revoke(SYSTEM, target.id, { reason: 'cli' });
          this.out('1 assignment revoked');
          return;
        }

        const [result] = await admin.execute(SYSTEM, [{ kind: 'assignment.revokeWhere', subject: target.subject, role: target.role, scope: target.scope }], { reason: 'cli' });
        if (!result) throw new CliUsageError('the admin returned no result');
        if (!result.ok) throw new CliUsageError(`${result.error.message} (${result.error.code})`);
        if (result.affected === 0) throw new CliUsageError('no assignment matched: 0 revoked');
        this.out(`${result.affected} assignment(s) revoked`);
      },
    );
  }
}
