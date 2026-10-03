import { randomBytes, createHash } from 'crypto';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';

import { AccessTokenGenerationProvider, IGeneratedToken } from './generation.js';

/**
 * Throws unless the prefix is a non-empty string and the length at least 32 bytes (256 bits, A14).
 * Defence in depth next to the authn config schema.
 */
export function checkTokenFormat(prefix: unknown, length: unknown): void {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new Error('authn.token.prefix must be a non-empty string');
  }
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 32) {
    throw new Error('authn.token.length must be an integer of at least 32 (bytes)');
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
