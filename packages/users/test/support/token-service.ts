import { DI } from '@spinajs/di';
import { TokenService } from '@spinajs/authn/contracts';
import type { AuthnContext, IdentityRef, PrincipalRef, TokenCreateResult, TokenRecord, TokenValidation } from '@spinajs/authn/contracts';
import { currentPrincipal } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';

export interface RevokeAllForCall {
  readonly owner: IdentityRef;
  readonly ctx: AuthnContext;
  readonly opts?: { readonly actor?: PrincipalRef };
  /** authn-token's audit sinks run under this principal. */
  readonly ambient: Principal;
}

/** One per process, recording every revokeAllFor; users calls nothing else on a TokenService. */
export class RecordingTokenService extends TokenService {
  public static readonly calls: RevokeAllForCall[] = [];

  public async revokeAllFor(owner: IdentityRef, ctx: AuthnContext, opts?: { readonly actor?: PrincipalRef }): Promise<number> {
    RecordingTokenService.calls.push({ owner, ctx, ...(opts ? { opts } : {}), ambient: currentPrincipal() });
    return 0;
  }

  public create(): Promise<TokenCreateResult> {
    throw new Error('not used');
  }

  public list(): Promise<readonly TokenRecord[]> {
    throw new Error('not used');
  }

  public revoke(): Promise<boolean> {
    throw new Error('not used');
  }

  public validate(): Promise<TokenValidation> {
    throw new Error('not used');
  }
}

let registered = false;

/** Registered for the rest of the process (DI has no clean undo). */
export function registerRecordingTokenService(): void {
  if (!registered) {
    registered = true;
    DI.register(RecordingTokenService).as(TokenService);
  }
}
