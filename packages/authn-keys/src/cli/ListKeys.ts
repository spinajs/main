import { Autoinject } from '@spinajs/di';
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { Log, Logger } from '@spinajs/log';
import { KeyRegistry } from '@spinajs/authn/contracts';
import type { KeyRecord } from '@spinajs/authn/contracts';
import { OWNER_TYPES, ownerArg } from './common.js';

const iso = (d?: Date): string => (d ? d.toISOString() : '-');

export function keyLine(k: KeyRecord): string {
  return [k.kid, k.alg, k.name ?? '-', `created ${iso(k.createdAt)}`, `expires ${iso(k.expiresAt)}`, `revoked ${iso(k.revokedAt)}`, `last used ${iso(k.lastUsedAt)}`].join('  ');
}

@Command('authn:key-list', 'Lists the public keys of a user, a service or an agent, revoked and expired ones included')
@Argument({ name: 'ownerType', required: true, description: OWNER_TYPES.join(', '), choices: OWNER_TYPES })
@Argument('ownerId', true, 'id of the owner (users.Uuid for users)')
export class ListKeys extends CliCommand {
  @Logger('authn-keys')
  protected Log: Log;

  @Autoinject(KeyRegistry)
  protected Registry: KeyRegistry;

  public async execute(ownerType: string, ownerId: string): Promise<void> {
    const keys = await this.Registry.list(ownerArg(ownerType, ownerId));
    if (keys.length === 0) {
      this.Log.info('No keys');
    }
    for (const k of keys) {
      this.Log.info(keyLine(k));
    }
  }
}
