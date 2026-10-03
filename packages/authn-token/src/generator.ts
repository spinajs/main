import { randomBytes, createHash } from 'crypto';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';

import { AccessTokenGenerationProvider, IGeneratedToken } from './generation.js';

/** TokenStrategy treats a longer value as not a token, so nothing longer may be minted. */
export const MAX_TOKEN_LENGTH = 1024;

/**
 * Throws unless the prefix is a non-empty string, the length at least 32 bytes (256 bits, A14) and the token
 * at most `MAX_TOKEN_LENGTH` characters. Defence in depth next to the authn config schema.
 */
export function checkTokenFormat(prefix: unknown, length: unknown): void {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new Error('authn.token.prefix must be a non-empty string');
  }
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 32) {
    throw new Error('authn.token.length must be an integer of at least 32 (bytes)');
  }
  if (prefix.length + Math.ceil((length * 4) / 3) > MAX_TOKEN_LENGTH) {
    throw new Error(`authn.token.prefix and authn.token.length make tokens longer than ${MAX_TOKEN_LENGTH} characters`);
  }
}

/**
 * Default token algorithm: `<prefix>` + N crypto-random bytes base64url encoded.
 * The stable prefix makes leaked tokens findable by secret scanners.
 */
@Injectable(AccessTokenGenerationProvider)
export class SecureRandomTokenProvider extends AccessTokenGenerationProvider {
  @Config('authn.token.prefix', { defaultValue: 'spt_' })
  protected Prefix: string;

  @Config('authn.token.length', { defaultValue: 32 })
  protected Length: number;

  public async generate(): Promise<IGeneratedToken> {
    checkTokenFormat(this.Prefix, this.Length);
    const plaintext = `${this.Prefix}${randomBytes(this.Length).toString('base64url')}`;
    return { Plaintext: plaintext, Hash: this.hash(plaintext) };
  }

  public hash(plaintext: string): string {
    return createHash('sha256').update(plaintext).digest('hex');
  }
}
