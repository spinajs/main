import { Log, Logger } from '@spinajs/log';
import { Argument, Command, Option } from '@spinajs/cli';
import { Config } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { TokenService } from '@spinajs/authn/contracts';
import type { TokenCreateOptions, TokenKind } from '@spinajs/authn/contracts';
import { DateTime } from 'luxon';

import { TokenCliCommand } from './TokenCliCommand.js';

interface ICreateTokenOptions {
  name: string;
  roles?: string;
  kind?: string;
  profile?: string;
  expires?: string;
}

const DAY_MS = 86_400_000;
/** Agent tokens are minted for a running agent, never by hand. */
const CLI_KINDS: readonly string[] = ['pat', 'service'] satisfies readonly TokenKind[];

@Command('authn:token-create', 'Creates an API token for a user')
@Argument('ownerUuid', true, 'uuid of the owning user')
@Option('-n, --name <name>', true, 'token label')
@Option('-r, --roles <roles>', false, 'roles the token may use, comma separated; omit for no role ceiling')
@Option('-k, --kind <kind>', false, 'pat or service', 'pat')
@Option('-p, --profile <profile>', false, 'profile to pin the token to')
@Option('-e, --expires <expires>', false, 'ISO expiry instant; omit for authn.token.defaultTtlDays from now')
export class CreateToken extends TokenCliCommand {
  @Logger('authn-token')
  protected Log: Log;

  @Config('authn.token.defaultTtlDays', { defaultValue: 30 })
  protected DefaultTtlDays: number;

  public async execute(ownerUuid: string, options: ICreateTokenOptions): Promise<void> {
    try {
      const now = new Date();

      const kind = options.kind ?? 'pat';
      if (!CLI_KINDS.includes(kind)) {
        this.Log.error('Token not created: invalid_scope (--kind must be pat or service)');
        return;
      }

      const expiresAt = this.expiryOf(options.expires, now);
      if (expiresAt === null) {
        this.Log.error('Token not created: invalid_expiry (--expires is not an ISO instant)');
        return;
      }

      const opts: TokenCreateOptions = {
        name: options.name,
        kind: kind as 'pat' | 'service',
        expiresAt,
        ...(options.roles !== undefined
          ? {
              roles: options.roles
                .split(',')
                .map((r) => r.trim())
                .filter((r) => r.length > 0),
            }
          : {}),
        ...(options.profile !== undefined ? { profile: options.profile } : {}),
      };

      const tokens = await DI.resolve(TokenService);
      const result = await tokens.create({ type: 'user', id: ownerUuid }, opts, { now, purpose: 'request' });
      if (!result.ok) {
        this.Log.error(`Token not created: ${result.code}`);
        return;
      }

      this.Log.success(`Token ${result.record.id} created, expires ${result.record.expiresAt.toISOString()}`);
      this.Log.success(`Token ( copy now, it will not be shown again ): ${result.plaintext}`);
    } catch (e) {
      this.Log.error(`Error while creating token: ${(e as Error).message}`);
    }
  }

  /** null: refused. An empty `--expires` was meant as a date, so it is refused rather than read as absent. */
  protected expiryOf(expires: string | undefined | null, now: Date): Date | null {
    if (expires === undefined || expires === null) {
      const days = this.DefaultTtlDays;
      if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) {
        throw new Error('authn.token.defaultTtlDays must be a positive number');
      }
      return new Date(now.getTime() + days * DAY_MS);
    }

    const parsed = DateTime.fromISO(expires);
    return parsed.isValid ? parsed.toJSDate() : null;
  }
}
