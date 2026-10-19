import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { CLI_ACTOR, TokenService, cliContext } from '@spinajs/authn/contracts';
import type { AuthnContext, PrincipalRef } from '@spinajs/authn/contracts';
import { InvalidOperation } from '@spinajs/exceptions';

interface TokenRevoker {
  revokeById(id: string, ctx: AuthnContext, opts?: { readonly actor?: PrincipalRef }): Promise<boolean>;
}

const revokesById = (s: unknown): s is TokenRevoker => typeof (s as Partial<TokenRevoker> | null)?.revokeById === 'function';

@Command('authn:token-delete', 'Revokes an API token, whoever owns it')
@Argument('uuid', true, 'token uuid')
export class DeleteToken extends CliCommand {
  @Logger('authn-token')
  protected Log: Log;

  @Autoinject(TokenService)
  protected Tokens: TokenService;

  public async execute(uuid: string): Promise<void> {
    try {
      const tokens = this.Tokens;
      if (!revokesById(tokens)) {
        throw new InvalidOperation(`${tokens.constructor.name} cannot revoke a token by id`);
      }

      if (await tokens.revokeById(uuid, cliContext(), { actor: CLI_ACTOR })) {
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
