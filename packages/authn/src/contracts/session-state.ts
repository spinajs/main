import { NewInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { isNonEmptyString, isPlainObject } from '@spinajs/util';

import type { IdentityRef } from './credentials.js';
import type { AuthnFacts, PrincipalRef } from './principal.js';
import type { SessionHandle } from './session.js';

/** A typed entry of session data. `decode` gets the stored value whenever the key is present, null included. */
export interface SessionKey<T> {
  readonly name: string;
  decode(raw: unknown): T;
}

export function sessionKey<T>(name: string, decode: (raw: unknown) => T): SessionKey<T> {
  return Object.freeze({ name, decode });
}

export interface ImpersonationBlock {
  readonly startedAt: Date;
  /** The role of the actor's role switch at start; [] when that switch narrowed to no role. */
  readonly actorRoles?: readonly string[];
}

const nonEmpty = (raw: unknown): string | undefined => (isNonEmptyString(raw) ? raw : undefined);

function activeRole(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  // A value no role switch writes narrows to no role instead of lifting the narrowing.
  return isNonEmptyString(raw) ? raw : '';
}

function impersonationBlock(raw: unknown): ImpersonationBlock | null {
  if (!isPlainObject(raw)) return null;
  const started: unknown = typeof raw.startedAt === 'string' ? new Date(raw.startedAt) : raw.startedAt;
  if (!(started instanceof Date) || Number.isNaN(started.getTime())) return null;
  if (!('actorRoles' in raw)) return { startedAt: started };
  const roles: unknown = raw.actorRoles;
  // A role switch writes at most one role.
  if (!Array.isArray(roles) || roles.length > 1 || !roles.every(isNonEmptyString)) return null;
  return { startedAt: started, actorRoles: Object.freeze([...roles]) };
}

function pendingSteps(raw: unknown): readonly string[] | undefined {
  return Array.isArray(raw) && raw.length > 0 && raw.every((s) => typeof s === 'string') ? Object.freeze([...raw]) : undefined;
}

/** The data keys authn reads. An app defines its own with `sessionKey` and reads them with `Session.get`. */
export const SessionKeys = Object.freeze({
  /** Written by a role switch (D14); '' narrows to no role. */
  ActiveRole: sessionKey('ActiveRole', activeRole),
  /** Written by impersonation start; null when it cannot be read. */
  Impersonation: sessionKey('Impersonation', impersonationBlock),
  Ip: sessionKey('Ip', nonEmpty),
  UserAgent: sessionKey('UserAgent', nonEmpty),
  /** Only on a pending session, from the issuer; DefaultSessionIssuer's `set` refuses it. */
  PendingSteps: sessionKey('authn:pendingSteps', pendingSteps),
});

export interface SessionInit {
  readonly handle: SessionHandle;
  readonly identity: IdentityRef;
  readonly facts: AuthnFacts;
  readonly data?: Iterable<readonly [string, unknown]>;
}

/** A restored session. Read data through a SessionKey; `data` holds the raw public entries. */
@NewInstance()
export class Session {
  public readonly handle: SessionHandle;
  public readonly identity: IdentityRef;
  public readonly facts: AuthnFacts;
  public readonly data: ReadonlyMap<string, unknown>;

  constructor(init: SessionInit) {
    this.handle = init.handle;
    this.identity = init.identity;
    this.facts = init.facts;
    this.data = new Map(init.data ?? []);
  }

  public get state(): SessionHandle['state'] {
    return this.handle.state;
  }

  public get impersonator(): PrincipalRef | undefined {
    return this.facts.impersonator;
  }

  public get activeRole(): string | undefined {
    return this.get(SessionKeys.ActiveRole);
  }

  /** undefined without a block (a migrated 2.x session), null for one that cannot be read. */
  public get impersonation(): ImpersonationBlock | null | undefined {
    return this.get(SessionKeys.Impersonation);
  }

  public get ip(): string | undefined {
    return this.get(SessionKeys.Ip);
  }

  public get userAgent(): string | undefined {
    return this.get(SessionKeys.UserAgent);
  }

  public get pendingSteps(): readonly string[] | undefined {
    return this.get(SessionKeys.PendingSteps);
  }

  public has(key: SessionKey<unknown>): boolean {
    return this.data.has(key.name);
  }

  public get<T>(key: SessionKey<T>): T | undefined {
    return this.data.has(key.name) ? key.decode(this.data.get(key.name)) : undefined;
  }
}

/**
 * `value` itself when it is a Session, else the class registered as Session in `container` (Session when none is),
 * built from `value`. A registered class must be @NewInstance() and must not depend on an AsyncService.
 */
export function resolveSession(container: IContainer, value: Session | SessionInit): Session {
  if (value instanceof Session) return value;
  const session: unknown = container.resolve(Session, [value]);
  if (!(session instanceof Session)) {
    throw new Error('authn: the class registered as Session resolved to a value that is not a Session (an AsyncService dependency resolves to a Promise)');
  }
  // A singleton registration ignores the constructor arguments and hands back the first session again.
  if (session.handle.id !== value.handle.id) {
    throw new Error(`authn: declare @NewInstance() on ${session.constructor.name}; a shared instance would hand one session to every request`);
  }
  return session;
}
