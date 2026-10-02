import type { ExternalSubject, IdentityRef } from './credentials.js';

export interface IdentityLink {
  readonly id: string;
  readonly identity: IdentityRef;
  readonly provider: string;
  readonly subject: string;
  readonly email?: string;
  readonly linkedAt: Date;
  readonly lastUsedAt?: Date;
}

/** One identity, many external subjects. DbIdentityLinkStore in authn-orm (authn_identity). */
export abstract class IdentityLinkStore {
  /** (provider, subject) is unique (A19). */
  abstract find(provider: string, subject: string): Promise<IdentityLink | null>;
  abstract list(identity: IdentityRef): Promise<readonly IdentityLink[]>;
  abstract link(identity: IdentityRef, external: ExternalSubject): Promise<IdentityLink>;
  /** Takes the link id. AccountLinkService, not the store, refuses to remove the last usable credential. */
  abstract unlink(id: string): Promise<void>;
}
