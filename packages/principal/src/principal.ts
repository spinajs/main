/** 'users', 'file', 'ArrowCampaign', 'job', 'dir' */
export type ResourceType = string;
export interface ResourceRef {
  readonly type: ResourceType;
  /** Absent = type-level (collections, "some row"). */
  readonly id?: string;
}

export type PrincipalType = 'user' | 'anonymous' | 'unattended' | 'system' | 'service' | 'link' | 'agent' | 'group' | (string & {});
export interface PrincipalRef {
  readonly type: PrincipalType;
  readonly id: string;
}

export interface Principal extends PrincipalRef {
  /** False for anonymous and unattended; true for a link bearer. */
  readonly authenticated: boolean;
  /** 'session' | 'token' | 'link' | 'runAs' | 'queue' | app */
  readonly source: string;
  /** Agents, delegated tokens; the answer is at most the delegate's. */
  readonly onBehalfOf?: Principal;
  /** With onBehalfOf; default 'intersect'. */
  readonly delegation?: 'intersect' | 'inherit';
  /** Identities that also speak in this request (the signed-in user behind a link). */
  readonly companions?: readonly PrincipalRef[];
  readonly ceiling?: Ceiling;
  readonly attributes: Readonly<Record<string, unknown>>;
  /** The User model or app object; opaque to authz. */
  readonly identity?: unknown;
  /** Set by authn; conditions read 'principal.authn.*'. */
  readonly authn?: AuthnFacts;
}

export interface AuthnFacts {
  /** 'password' | 'token' | 'jws' | 'http-signature' | 'oidc' | 'ldap' | 'saml' */
  readonly method: string;
  /** Configured strategy name: 'local', 'token', 'keys', 'oidc:google'. */
  readonly strategy: string;
  /** 'aal2' when an MFA step passed. */
  readonly assurance: 'aal1' | 'aal2';
  /** Passed steps: ['totp']. */
  readonly mfa: readonly string[];
  readonly authenticatedAt: Date;
  /** Set while impersonating. */
  readonly impersonator?: PrincipalRef;
  /** Hashed session id, never the raw one. */
  readonly sessionHandle?: string;
}

export interface Ceiling {
  readonly roles?: readonly string[];
  /** Globs: 'file:*', 'project:read'. */
  readonly permissions?: readonly string[];
  /** Each covers itself and its descendants; [] covers nothing. */
  readonly resources?: readonly ResourceRef[];
  readonly expiresAt?: Date;
  /** Deny code when the ceiling fails; default 'ceiling'. */
  readonly reason?: string;
}

export const SYSTEM: Principal = Object.freeze({} as Principal);

export const UNATTENDED: Principal = Object.freeze({} as Principal);

export const principalKey = (_p: PrincipalRef): string => {
  throw new Error('not implemented: principalKey');
};

export const sameRef = (_a: PrincipalRef, _b: PrincipalRef): boolean => {
  throw new Error('not implemented: sameRef');
};

export const ceilingHash = (_c: Ceiling | undefined): string => {
  throw new Error('not implemented: ceilingHash');
};
