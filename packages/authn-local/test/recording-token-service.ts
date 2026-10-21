import { TokenService } from '@spinajs/authn/contracts';
import type { AuthnContext, IdentityRef, PrincipalRef, TokenCreateOptions, TokenCreateResult, TokenRecord, TokenRotateResult, TokenUpdate, TokenUpdateResult, TokenValidation } from '@spinajs/authn/contracts';

/** Records every call; only revokeAllFor answers, the rest fail the test if reached. */
export class RecordingTokenService extends TokenService {
  public readonly calls: { method: string; args: unknown[] }[] = [];

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
  }

  public async create(owner: IdentityRef, opts: TokenCreateOptions, ctx: AuthnContext): Promise<TokenCreateResult> {
    this.record('create', [owner, opts, ctx]);
    throw new Error('RecordingTokenService.create is not expected here');
  }

  public async list(owner: IdentityRef): Promise<readonly TokenRecord[]> {
    this.record('list', [owner]);
    return [];
  }

  public async revoke(owner: IdentityRef, id: string, ctx: AuthnContext, opts?: { readonly actor?: PrincipalRef }): Promise<boolean> {
    this.record('revoke', [owner, id, ctx, opts]);
    return false;
  }

  public async rotate(owner: IdentityRef, id: string, ctx: AuthnContext, opts?: { readonly graceSeconds?: number }): Promise<TokenRotateResult> {
    this.record('rotate', [owner, id, ctx, opts]);
    throw new Error('RecordingTokenService.rotate is not expected here');
  }

  public async update(owner: IdentityRef, id: string, change: TokenUpdate, ctx: AuthnContext): Promise<TokenUpdateResult> {
    this.record('update', [owner, id, change, ctx]);
    throw new Error('RecordingTokenService.update is not expected here');
  }

  public async revokeAllFor(owner: IdentityRef, ctx: AuthnContext, opts?: { readonly actor?: PrincipalRef }): Promise<number> {
    this.record('revokeAllFor', [owner, ctx, opts]);
    return 0;
  }

  public async validate(raw: string, ctx: AuthnContext): Promise<TokenValidation> {
    this.record('validate', [raw, ctx]);
    return { ok: false, reason: 'invalid_credentials' };
  }
}
