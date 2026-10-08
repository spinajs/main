import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { Log, Logger } from '@spinajs/log';
import { AuthenticationStrategy, TokenService } from '@spinajs/authn/contracts';
import type { AuthnContext, Credentials, StrategyOutcome, ThrottleKey, TokenRecord } from '@spinajs/authn/contracts';

import { MAX_TOKEN_LENGTH, checkTokenSize } from '../generator.js';

/** Implemented by DbTokenService; a TokenService without it gets no last-used stamps. */
export interface TokenUseRecorder {
  touch(id: string, ctx: AuthnContext, intervalSeconds: number): Promise<boolean>;
}

const recordsUse = (s: unknown): s is TokenUseRecorder => typeof (s as Partial<TokenUseRecorder> | null)?.touch === 'function';

/**
 * API tokens (`spt_…`) sent as `bearer` credentials; authn-http turns the `x-api-key` header into one too.
 * Shares the `bearer` kind with JwtBearerStrategy, so a value outside its format is `unsupported_credentials`
 * without any I/O and the dispatch passes it on.
 */
@Injectable(AuthenticationStrategy)
@Inject(TokenService)
export class TokenStrategy extends AuthenticationStrategy {
  public readonly name = 'token';
  public readonly kinds: readonly string[] = ['bearer'];
  public readonly interactive = false;

  @Config('authn.token.prefix')
  protected Prefix: string;

  @Config('authn.token.length')
  protected Length: number;

  @Config('authn.token.lastUsedUpdateInterval')
  protected LastUsedUpdateInterval: number;

  @Logger('authn-token')
  protected Log: Log;

  constructor(protected readonly tokens: TokenService) {
    super();
  }

  /** Fails boot on a token format over the size cap. TokenService is injected, so a missing IdentityStore already failed. */
  public async resolve(): Promise<void> {
    checkTokenSize(this.Prefix, this.Length);
  }

  /** N1's CredentialSelector hook: true only for a bearer value in this strategy's format. */
  public accepts(c: Credentials): boolean {
    return this.tokenOf(c) !== null;
  }

  /**
   * Reads the credential once: a getter or proxy could answer differently on a second read and slip an
   * out-of-format value past the format gate. A hostile object reads as "not ours".
   */
  protected tokenOf(c: Credentials): string | null {
    let token: unknown;
    try {
      // Credentials does not narrow by kind, so every field is checked at runtime.
      if (typeof c !== 'object' || c === null || c.kind !== 'bearer') {
        return null;
      }
      token = (c as { token?: unknown }).token;
    } catch {
      return null;
    }
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) {
      return null;
    }
    // Outside the try and only for a bearer value: a refused authn.token section fails a token request instead of
    // reading as "not ours", and never touches other credential kinds.
    const prefix = this.Prefix;
    if (prefix.length === 0 || !token.startsWith(prefix)) {
      return null;
    }
    return token;
  }

  public throttleKeys(c: Credentials, ctx: AuthnContext): readonly ThrottleKey[] {
    const token = this.tokenOf(c);
    if (token === null) {
      return [];
    }

    const id = `token:${createHash('sha256').update(`authn-token-throttle:${token}`).digest('hex').slice(0, 32)}`;
    return [
      { kind: 'account', value: id },
      { kind: 'account-ip', value: `${id}|${ctx?.ip ?? ''}` },
    ];
  }

  public async verify(c: Credentials, ctx: AuthnContext): Promise<StrategyOutcome> {
    const token = this.tokenOf(c);
    if (token === null) {
      return { ok: false, reason: 'unsupported_credentials' };
    }

    const v = await this.tokens.validate(token, ctx);
    if (!v.ok) {
      return { ok: false, reason: v.reason };
    }

    await this.stamp(v.token, ctx);

    return {
      ok: true,
      identity: { type: v.identity.type, id: v.identity.id },
      method: 'token',
      ...(v.ceiling !== undefined ? { ceiling: v.ceiling } : {}),
      ...(v.delegation !== undefined ? { delegation: v.delegation } : {}),
      ...(v.profile !== undefined ? { attributes: { profile: v.profile } } : {}),
    };
  }

  /** Awaited, so tests and fake time see the write; a failure costs the stamp, never the request. */
  protected async stamp(token: TokenRecord | undefined, ctx: AuthnContext): Promise<void> {
    if (!recordsUse(this.tokens) || !token?.id) {
      return;
    }

    try {
      const interval = this.LastUsedUpdateInterval;
      const last = token.lastUsedAt?.getTime();
      if (last !== undefined && last >= ctx.now.getTime() - interval * 1000) {
        return;
      }
      await this.tokens.touch(token.id, ctx, interval);
    } catch (err) {
      this.Log.error(err as Error, `Could not stamp the last use of access token ${token.id}`);
    }
  }
}
