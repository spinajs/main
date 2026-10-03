import { Log, Logger } from '@spinajs/log';
import { Argument, Command } from '@spinajs/cli';
import { DI } from '@spinajs/di';
import { TokenService } from '@spinajs/authn/contracts';
import type { AuthnContext } from '@spinajs/authn/contracts';

import { TokenCliCommand } from './TokenCliCommand.js';

interface TokenRevoker {
  revokeById(id: string, ctx: AuthnContext): Promise<boolean>;
}

const revokesById = (s: unknown): s is TokenRevoker => typeof (s as Partial<TokenRevoker> | null)?.revokeById === 'function';

@Command('authn:token-delete', 'Revokes an API token, whoever owns it')
@Argument('uuid', true, 'token uuid')
export class DeleteToken extends TokenCliCommand {
  @Logger('authn-token')
  protected Log: Log;

  public async execute(uuid: string): Promise<void> {
    try {
      const tokens = await DI.resolve(TokenService);
      if (!revokesById(tokens)) {
        throw new Error(`${tokens.constructor.name} cannot revoke a token by id`);
      }

      if (await tokens.revokeById(uuid, { now: new Date(), purpose: 'request' })) {
        this.Log.success(`Token ${uuid} revoked`);
      } else {
        this.Log.warn(`Token ${uuid} not found or already revoked`);
      }
    } catch (e) {
      this.Log.error(`Error while revoking token ${uuid}: ${(e as Error).message}`);
    }
  }
}
