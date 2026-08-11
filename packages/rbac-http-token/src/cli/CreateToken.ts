import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command, Option } from '@spinajs/cli';
import { DateTime } from 'luxon';

import { createToken } from '../actions.js';

interface ICreateTokenOptions {
  name: string;
  roles: string;
  expires?: string;
}

@Command('rbac:token-create', 'Creates an access token for a user')
@Argument('userIdOrUuid', true, 'numeric id or uuid of the owner')
@Option('-n, --name <name>', true, 'token label')
@Option('-r, --roles <roles>', true, 'token roles, comma separated, must be subset of owner roles')
@Option('-e, --expires <expires>', false, 'ISO expiration instant; omit for a token that never expires')
export class CreateToken extends CliCommand {
  @Logger('rbac-http-token')
  protected Log: Log;

  public async execute(userIdOrUuid: string, options: ICreateTokenOptions): Promise<void> {
    try {
      const expiresAt = options.expires ? DateTime.fromISO(options.expires) : null;
      if (expiresAt && !expiresAt.isValid) {
        this.Log.error(`Invalid --expires value: ${options.expires}`);
        return;
      }

      const roles = options.roles
        .split(',')
        .map((r) => r.trim())
        .filter((r) => r.length > 0);
      const owner = /^\d+$/.test(userIdOrUuid) ? parseInt(userIdOrUuid, 10) : userIdOrUuid;

      const { Token, Plaintext } = await createToken(owner, options.name, roles, expiresAt);

      this.Log.success(`Token created: ${Token.Uuid}`);
      // The single moment the plaintext exists outside the caller's hands.
      this.Log.success(`Token ( copy now, it will not be shown again ): ${Plaintext}`);
    } catch (e) {
      this.Log.error(`Error while creating token: ${(e as Error).message}`);
    }
  }
}
