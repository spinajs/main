import { Autoinject } from '@spinajs/di';
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { Log, Logger } from '@spinajs/log';
import { KeyRegistry } from '@spinajs/authn/contracts';
import { CLI_ACTOR, OWNER_TYPES, cliContext, ownerArg } from './common.js';

@Command('authn:key-revoke', 'Revokes a public key; it fails on the next request')
@Argument({ name: 'ownerType', required: true, description: OWNER_TYPES.join(', '), choices: OWNER_TYPES })
@Argument('ownerId', true, 'id of the owner (users.Uuid for users)')
@Argument('kid', true, 'key id')
export class RevokeKey extends CliCommand {
  @Logger('authn-keys')
  protected Log: Log;

  @Autoinject(KeyRegistry)
  protected Registry: KeyRegistry;

  public async execute(ownerType: string, ownerId: string, kid: string): Promise<void> {
    if (!(await this.Registry.revoke(ownerArg(ownerType, ownerId), kid, cliContext(), { actor: CLI_ACTOR }))) {
      throw new Error(`no key ${kid} of ${ownerType} ${ownerId}`);
    }
    this.Log.success(`Key ${kid} revoked`);
  }
}
