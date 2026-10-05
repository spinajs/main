import { AccessDenied, AuthzClock, AuthzDomains, DEFAULT_DENY_PRIORITY, FALSE, principalKey, resourceKey } from '@spinajs/authz';
import type { CheckInput, Decision, Permission, Principal, ResourceRef } from '@spinajs/authz';
import type { IContainer } from '@spinajs/di';
import type { fs } from '@spinajs/fs';

import type { FsAccessMode } from '../access-config/index.js';
import { ensureFsDomain } from '../domain/index.js';
import type { FsPathKind, FsRow } from '../refs/index.js';

// Internal to the guard and the upload middleware: the barrel does not export this module.

/** The part of AuthzService the guard calls. */
export interface FsGuardService {
  check(req: CheckInput): Promise<Decision>;
  assert(principal: Principal, permission: Permission, resource?: ResourceRef | object, subject?: unknown): Promise<Decision>;
}

export interface FsGuardLog {
  warn(message: string): void;
  /** A metadata update that failed after the IO; default `warn`. */
  error?(message: string): void;
}

/** One check of one path: enforce asserts, audit checks and warns. */
export interface FsCheck {
  readonly fsName: string;
  readonly mode: Exclude<FsAccessMode, 'off'>;
  readonly service: FsGuardService;
  readonly log: FsGuardLog;
  readonly principal: Principal;
  readonly permission: Permission;
  readonly ref: ResourceRef;
  readonly subject: FsRow;
}

// A permit with a residual left (a relation or a resource.* condition the subject did not settle) is no permit here.
export const definite = (decision: Decision): boolean => decision.allowed && decision.residual?.op === 'true';

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

export function warnDenied(fsName: string, log: FsGuardLog, principal: Principal, permission: Permission, ref: ResourceRef, decision: Decision): void {
  const why = decision.allowed ? 'conditional' : decision.reason?.code;
  log.warn(`authz.fs.${fsName}: ${principalKey(principal)} lacks ${permission} on ${resourceKey(ref)}${why ? ` (${why})` : ''}; allowed in audit mode`);
}

/** The service of an fs domain, created with its fs models first when it is missing (D11). */
export async function domainService(container: IContainer, domain: string): Promise<FsGuardService> {
  ensureFsDomain(domain, container);
  return ((await container.resolve(AuthzDomains)) as AuthzDomains).service(domain);
}

/** `now` when it is a valid Date, else the system time. */
export const validNow = (now: unknown): Date => (now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date());

/** The AuthzClock of the domain, else the system time. */
export async function domainNow(container: IContainer, domain: string): Promise<Date> {
  try {
    const domains = (await container.resolve(AuthzDomains)) as AuthzDomains;
    const clock = (await domains.container(domain).resolve(AuthzClock)) as AuthzClock | undefined;
    return validNow(clock?.now());
  } catch {
    // no authz host or no such domain: the system time
  }
  return new Date();
}

export const refOf = (fsName: string, normalised: string, kind: FsPathKind): ResourceRef => (normalised === '' ? { type: 'fs', id: fsName } : { type: kind, id: `${fsName}:${normalised}` });

export function basePathOf(raw: unknown): string | undefined {
  const basePath: unknown = (raw as { Options?: { basePath?: unknown } } | null | undefined)?.Options?.basePath;
  return typeof basePath === 'string' && basePath !== '' ? basePath : undefined;
}

/** The provider fsService published under `name` in `container`, guarded or raw. */
export function publishedFs(container: IContainer, name: string): fs | undefined {
  const published: unknown = container.get('__file_provider_instance__');
  const provider: unknown = published instanceof Map ? published.get(name) : undefined;
  return provider !== null && typeof provider === 'object' ? (provider as fs) : undefined;
}
