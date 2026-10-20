import { AccessDenied, AuthzDomains, AuthzService, DEFAULT_DENY_PRIORITY, DefaultAuthzDomains, FALSE, definite, principalKey, resourceKey } from '@spinajs/authz';
import type { AuthzLog, CheckInput, Decision, Permission, Principal, ResourceRef } from '@spinajs/authz';
import type { IContainer } from '@spinajs/di';

import type { FsAccessMode } from '../access-config/index.js';
import type { FsPathKind, FsRow } from '../refs/index.js';

// Internal to the middleware, the facade and the upload middleware: the barrel does not export this module.

/** The part of AuthzService the fs checks call. */
export interface FsDecideService {
  check(req: CheckInput): Promise<Decision>;
  assert(principal: Principal, permission: Permission, resource?: ResourceRef | object, subject?: unknown): Promise<Decision>;
}

/** `error` is for a file ACL update that failed after the IO; default `warn`. */
export type FsLog = Pick<AuthzLog, 'warn'> & Partial<Pick<AuthzLog, 'error'>>;

/** One check of one path: enforce asserts, audit checks and warns. */
export interface FsCheck {
  readonly fsName: string;
  readonly mode: Exclude<FsAccessMode, 'off'>;
  readonly service: FsDecideService;
  readonly log: FsLog;
  readonly principal: Principal;
  readonly permission: Permission;
  readonly ref: ResourceRef;
  readonly subject: FsRow;
}

export async function decideFs({ fsName, mode, service, log, principal, permission, ref, subject }: FsCheck): Promise<Decision> {
  if (mode === 'enforce') {
    const decision = await service.assert(principal, permission, ref, subject);
    if (!definite(decision)) throw new AccessDenied(conditional(decision));
    return decision;
  }
  const decision = await service.check({ principal, permission, resource: ref, subject });
  if (!definite(decision)) warnDenied(fsName, log, principal, permission, ref, decision);
  return decision;
}

function conditional(decision: Decision): Decision {
  return { ...decision, allowed: false, residual: FALSE, reason: { code: 'needs_subject', priority: DEFAULT_DENY_PRIORITY.needs_subject } };
}

export function warnDenied(fsName: string, log: FsLog, principal: Principal, permission: Permission, ref: ResourceRef, decision: Decision): void {
  const why = decision.allowed ? 'conditional' : decision.reason?.code;
  log.warn({ fsName, principal: principalKey(principal), permission, resource: resourceKey(ref), why }, 'authz.fs.${fsName}: ${principal} lacks ${permission} on ${resource}${?why} (${why})${/why}; allowed in audit mode');
}

/** 'root' is the root AuthzService; any other domain must exist already (`authz.domains`): it is never created here. */
export async function domainService(container: IContainer, domain: string): Promise<FsDecideService> {
  if (domain === 'root') return (await container.resolve(AuthzService)) as AuthzService;
  return ((await container.resolve(AuthzDomains)) as AuthzDomains).service(domain);
}

/** `now` when it is a valid Date, else the system time. */
export const validNow = (now: unknown): Date => (now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date());

/** The AuthzClock the domain's service booted with, else the system time. */
export async function domainNow(container: IContainer, domain: string): Promise<Date> {
  try {
    const domains = await container.resolve(AuthzDomains);
    if (domains instanceof DefaultAuthzDomains) return validNow(domains.clock(domain).now());
  } catch {
    // no authz host, no such domain or its service has not booted: the system time
  }
  return new Date();
}

export const refOf = (fsName: string, normalised: string, kind: FsPathKind): ResourceRef => (normalised === '' ? { type: 'fs', id: fsName } : { type: kind, id: `${fsName}:${normalised}` });
