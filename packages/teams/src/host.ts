import { AuthzAdminFailure, AuthzDomains, AuthzService, SYSTEM, runWithPrincipal } from '@spinajs/authz';
import type { AuthzCommand, AuthzCommandResult, Permission, Principal, ResourceRef } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

/** The domain authz-orm keeps the teams' ancestors in. */
export async function teamsDomain(): Promise<string> {
  const cfg = (await DI.resolve(Configuration)) as Configuration;
  const name = cfg.get<unknown>(['authz', 'orm', 'domain'], 'root');
  return typeof name === 'string' && name !== '' ? name : 'root';
}

export async function domainService(): Promise<AuthzService> {
  const domain = await teamsDomain();
  if (domain === 'root') return (await DI.resolve(AuthzService)) as AuthzService;
  return (await DI.resolve(AuthzDomains)).service(domain);
}

export async function domainContainer(): Promise<IContainer> {
  const domain = await teamsDomain();
  if (domain === 'root') return DI.RootContainer;
  return (await DI.resolve(AuthzDomains)).container(domain);
}

export async function teamsDriver(): Promise<OrmDriver> {
  const driver = ((await DI.resolve(Orm)) as Orm).Connections.get('default');
  if (!driver) throw new InvalidOperation('@spinajs/teams: no ORM connection named default');
  return driver;
}

export const asSystem = <T>(fn: () => Promise<T>): Promise<T> => runWithPrincipal(SYSTEM, fn);

export const asActor = <T>(actor: Principal, fn: () => Promise<T>): Promise<T> => runWithPrincipal(actor, fn);

/** @throws AccessDenied */
export async function assertAllowed(actor: Principal, permission: Permission, resource: ResourceRef): Promise<void> {
  await (await domainService()).assert(actor, permission, resource);
}

/** One AuthzAdmin batch; the first failed command is thrown as AuthzAdminFailure. */
export async function execute(actor: Principal, commands: readonly AuthzCommand[], reason: string, opts: { readonly dryRun?: boolean } = {}): Promise<readonly AuthzCommandResult[]> {
  if (commands.length === 0) return [];
  const results = await (await domainService()).admin().execute(actor, commands, { reason, ...(opts.dryRun ? { dryRun: true } : {}) });
  for (const r of results) if (!r.ok) throw new AuthzAdminFailure(r.error.code, r.error.message, r.error.field);
  return results;
}
