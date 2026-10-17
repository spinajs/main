import { Log, Logger } from '@spinajs/log';
import { Argument, Command } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { TokenService } from '@spinajs/authn/contracts';
import type { AuthnContext, PrincipalRef } from '@spinajs/authn/contracts';

import { TokenCliCommand } from './TokenCliCommand.js';

interface TokenRevoker {
  revokeById(id: string, ctx: AuthnContext, opts?: { readonly actor?: PrincipalRef }): Promise<boolean>;
}

/** Tells an operator's revoke apart from an owner's own in the audit. */
const CLI_ACTOR: PrincipalRef = Object.freeze({ type: 'system', id: 'cli' });

const revokesById = (s: unknown): s is TokenRevoker => typeof (s as Partial<TokenRevoker> | null)?.revokeById === 'function';

@Command('authn:token-delete', 'Revokes an API token, whoever owns it')
@Argument('uuid', true, 'token uuid')
export class DeleteToken extends TokenCliCommand {
  @Logger('authn-token')
  protected Log: Log;

  @Autoinject(TokenService)
  protected Tokens: TokenService;

  public async execute(uuid: string): Promise<void> {
    try {
      const tokens = this.Tokens;
      if (!revokesById(tokens)) {
        throw new Error(`${tokens.constructor.name} cannot revoke a token by id`);
      }

      if (await tokens.revokeById(uuid, { now: new Date(), purpose: 'request' }, { actor: CLI_ACTOR })) {
        this.Log.success({ uuid }, 'Token ${uuid} revoked');
      } else {
        this.Log.warn({ uuid }, 'Token ${uuid} not found or already revoked');
      }
    } catch (e) {
      this.Log.error({ error: e, uuid }, 'Error while revoking token ${uuid}');
      process.exitCode = 1;
    }
  }
}
