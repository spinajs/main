import { randomBytes, createHash } from 'crypto';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';

import { AccessTokenGenerationProvider, IGeneratedToken } from './generation.js';

/** TokenStrategy treats a longer value as not a token, so nothing longer may be minted. */
export const MAX_TOKEN_LENGTH = 1024;

/** The schema bounds prefix and length one by one; their sum is a string length plus a byte count, which only code can add. */
export function checkTokenSize(prefix: string, length: number): void {
  // The schema is the gate; this floor holds for values that never went through it.
  if (!(Number.isInteger(length) && length >= 32)) {
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
  @Config('authn.token.prefix')
  protected Prefix: string;

  @Config('authn.token.length')
  protected Length: number;

  public async generate(): Promise<IGeneratedToken> {
    checkTokenSize(this.Prefix, this.Length);
    const plaintext = `${this.Prefix}${randomBytes(this.Length).toString('base64url')}`;
    return { Plaintext: plaintext, Hash: this.hash(plaintext) };
  }

  public hash(plaintext: string): string {
    return createHash('sha256').update(plaintext).digest('hex');
  }
}
