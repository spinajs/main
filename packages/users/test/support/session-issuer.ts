import { DI } from '@spinajs/di';
import { SessionIssuer } from '@spinajs/authn/contracts';
import type { IdentityRef, SessionHandle } from '@spinajs/authn/contracts';
import { MemorySessionIssuer } from '@spinajs/authn-testing';

export interface RevokeAllCall {
  readonly subject: IdentityRef;
  readonly opts?: { except?: SessionHandle; includeImpersonations?: boolean };
}

/** The kit's in-memory issuer, one per process, recording every revokeAll. */
export class RecordingSessionIssuer extends MemorySessionIssuer {
  public static readonly calls: RevokeAllCall[] = [];

  public override async revokeAll(subject: IdentityRef, opts?: { except?: SessionHandle; includeImpersonations?: boolean }): Promise<number> {
    RecordingSessionIssuer.calls.push({ subject, ...(opts ? { opts } : {}) });
    return super.revokeAll(subject, opts);
  }
}

let registered = false;

/** Registered for the rest of the process (DI has no clean undo); users only calls revokeAll on it. */
export function registerRecordingSessionIssuer(): void {
  if (!registered) {
    registered = true;
    DI.register(RecordingSessionIssuer).as(SessionIssuer);
  }
}
