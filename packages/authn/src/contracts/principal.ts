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

// Singletons: the engine recognises them by identity, not by shape.
export const SYSTEM: Principal = Object.freeze({
  type: 'system',
  id: 'system',
  authenticated: true,
  source: 'runAs',
  attributes: Object.freeze({}),
});

export const UNATTENDED: Principal = Object.freeze({
  type: 'unattended',
  id: 'unattended',
  authenticated: false,
  source: 'unattended',
  attributes: Object.freeze({}),
});

// Feeds cache keys and invalidation tags, so it must be injective: the type
// part never contains ':', which leaves the first ':' as the separator.
export const principalKey = (p: PrincipalRef): string => `${p.type.replace(/%/g, '%25').replace(/:/g, '%3A')}:${p.id}`;

const canonicalSet = (values: readonly string[] | undefined): string[] | null => (values == null ? null : [...new Set(values)].sort());

// A collision here would serve one principal another's cached decision, so
// this is a canonical serialization rather than a short hash. null marks an
// absent field and stays distinct from [] (absent restricts nothing, [] covers
// nothing). A null read back from JSON counts as absent; the ceiling
// evaluator must apply the same rule.
export const ceilingHash = (c: Ceiling | undefined): string => {
  if (c == null) {
    return '';
  }

  const expires = c.expiresAt == null ? null : c.expiresAt.getTime();

  return JSON.stringify([
    canonicalSet(c.roles),
    canonicalSet(c.permissions),
    canonicalSet(c.resources?.map((r) => JSON.stringify([r.type, r.id ?? null]))),
    // JSON.stringify(NaN) is 'null', which would equal an absent date
    expires !== null && Number.isNaN(expires) ? 'invalid' : expires,
    c.reason ?? null,
  ]);
};
