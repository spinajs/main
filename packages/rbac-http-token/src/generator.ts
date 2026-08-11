import { randomBytes, createHash } from 'crypto';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';

import { AccessTokenGenerationProvider, IGeneratedToken } from './interfaces.js';

/**
 * Default token algorithm: `<prefix>` + N crypto-random bytes base64url encoded.
 * The stable prefix makes leaked tokens findable by secret scanners.
 */
@Injectable(AccessTokenGenerationProvider)
export class SecureRandomTokenProvider extends AccessTokenGenerationProvider {
  @Config('rbac.token.prefix', { defaultValue: 'spt_' })
  protected Prefix: string;

  @Config('rbac.token.length', { defaultValue: 32 })
  protected Length: number;

  public async generate(): Promise<IGeneratedToken> {
    const plaintext = `${this.Prefix}${randomBytes(this.Length).toString('base64url')}`;
    return { Plaintext: plaintext, Hash: this.hash(plaintext) };
  }

  public hash(plaintext: string): string {
    return createHash('sha256').update(plaintext).digest('hex');
  }
}
