import { AsyncLocalStorage } from 'node:async_hooks';

import { SYSTEM, authz, currentPrincipal, requestScope } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { ConnectionSessionSettings } from '@spinajs/orm';

import { ormDomain } from '../host.js';
import { RlsSubjectKeys } from '../plan/index.js';
import { RLS_SETTINGS } from './sql.js';

const SESSION_MEMO = 'authz-orm:rls-session';

/** `authz.orm.rls.session: true` turns the session on; generated policies show no row without it. */
export const rlsSessionEnabled = (): boolean => DI.get(Configuration)?.get<unknown>(['authz', 'orm', 'rls', 'session']) === true;

const isSystem = (p: Principal): boolean => p.type === SYSTEM.type && p.id === SYSTEM.id;

function subjectKeySources(): ReadonlyMap<string, RlsSubjectKeys> {
  const list = ((DI.resolve(Array.ofType(RlsSubjectKeys)) as unknown as RlsSubjectKeys[] | undefined) ?? []).filter((s) => s instanceof RlsSubjectKeys);
  return new Map(list.map((s) => [s.model, s]));
}

/**
 * The settings the generated row level security reads, per transaction: the principal's subject keys over
 * the domain's models, the principal and its companions, and `spina.bypass = 'on'` under SYSTEM (which only
 * the bypass role's policy honours). Computed once per request; the queries that compute them run without.
 */
@Injectable(ConnectionSessionSettings)
export class AuthzRlsSessionSettings extends ConnectionSessionSettings {
  private readonly computing = new AsyncLocalStorage<true>();

  async settings(): Promise<Readonly<Record<string, string>> | undefined> {
    if (this.computing.getStore() === true || !rlsSessionEnabled()) return undefined;
    const principal = currentPrincipal();
    if (isSystem(principal)) return { [RLS_SETTINGS.subjectKeys]: '[]', [RLS_SETTINGS.principal]: '[]', [RLS_SETTINGS.bypass]: 'on' };
    const cache = requestScope().cache ?? new Map<string, unknown>();
    const key = `${SESSION_MEMO}:${principal.type}:${principal.id}`;
    let memo = cache.get(key) as Promise<Readonly<Record<string, string>>> | undefined;
    if (memo === undefined) {
      memo = this.computing.run(true, () => this.compute(principal));
      cache.set(key, memo);
      memo.catch(() => cache.delete(key));
    }
    return memo;
  }

  private async compute(principal: Principal): Promise<Readonly<Record<string, string>>> {
    const sources = subjectKeySources();
    const keys = new Set<string>();
    for (const model of authz(ormDomain()).models()) {
      const source = sources.get(model.name);
      if (source !== undefined) for (const k of await source.keys(model, principal)) keys.add(k);
    }
    const principals = [principal, ...(principal.companions ?? [])].map((p) => ({ type: p.type, id: p.id }));
    return { [RLS_SETTINGS.subjectKeys]: JSON.stringify([...keys]), [RLS_SETTINGS.principal]: JSON.stringify(principals), [RLS_SETTINGS.bypass]: 'off' };
  }
}
