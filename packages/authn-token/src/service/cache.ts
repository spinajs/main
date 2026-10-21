import type { CredentialChange, CredentialChangeBus, TokenValidation } from '@spinajs/authn/contracts';

/** `authn.token.cache`. */
export interface TokenCacheConfig {
  /** 0 turns the cache off. */
  readonly ttlSeconds: number;
  readonly maxEntries: number;
}

export const DEFAULT_TOKEN_CACHE: TokenCacheConfig = Object.freeze({ ttlSeconds: 10, maxEntries: 10_000 });

export type ValidatedToken = Extract<TokenValidation, { ok: true }>;

/** Successful validations by token hash, evicted by the credential change bus. */
export class TokenValidationCache {
  constructor(
    protected readonly config: TokenCacheConfig,
    protected readonly bus?: CredentialChangeBus,
  ) {}

  public mark(): number {
    throw new Error('not implemented: TokenValidationCache.mark');
  }

  public get(_hash: string, _now: number): ValidatedToken | undefined {
    throw new Error('not implemented: TokenValidationCache.get');
  }

  public set(_hash: string, _validation: ValidatedToken, _expiresAt: number, _since: number): void {
    throw new Error('not implemented: TokenValidationCache.set');
  }

  public stamp(_id: string, _at: Date, _ip: string | null): void {
    throw new Error('not implemented: TokenValidationCache.stamp');
  }

  public evict(_change: CredentialChange): void {
    throw new Error('not implemented: TokenValidationCache.evict');
  }

  public dispose(): void {
    throw new Error('not implemented: TokenValidationCache.dispose');
  }
}
