import { AccessDenied, SYSTEM, principalKey } from '@spinajs/authz';
import type { Principal, PrincipalRef } from '@spinajs/authz';
import { InvalidArgument } from '@spinajs/exceptions';
import type { ISelectQueryBuilder } from '@spinajs/orm';

import type { Page, Paged } from '../api.js';
import { asActor } from '../host.js';
import { readSubject } from '../subjects.js';

export const isSystem = (p: Principal): boolean => p === SYSTEM || (p.type === SYSTEM.type && p.id === SYSTEM.id);

/** The audit reason of a teams batch; the actor is named because structural batches run as SYSTEM. */
export const reasonOf = (op: string, actor: Principal): string => `teams:${op} by ${principalKey(actor)}`;

/** The key stored in `created_by` columns (varchar 100). */
export const createdBy = (actor: Principal): string => principalKey(actor).slice(0, 100);

export function ownerOf(actor: Principal, owner: unknown): PrincipalRef {
  if (owner !== undefined) {
    const s = readSubject(owner, 'owner');
    if ('group' in s || 'team' in s) throw new InvalidArgument('owner must be a principal { type, id }', 'owner');
    return s;
  }
  if (isSystem(actor)) throw new InvalidArgument('owner: a SYSTEM caller must name the owner', 'owner');
  return { type: actor.type, id: actor.id };
}

/**
 * One page and the total of a list query. `query` builds a fresh builder each time (marks such as `.accessible()` are
 * per builder). `.accessible()` throws AccessDenied when the plan is `none`: a list the actor may see nothing of is empty.
 */
export async function pageOf<M, V>(actor: Principal, page: Page, query: () => ISelectQueryBuilder<M[]>, view: (m: M) => V): Promise<Paged<V>> {
  try {
    return await asActor(actor, async () => {
      const total = await query().selectCount();
      const rows = (await query().orderBy('name').skip(page.offset).take(page.limit)) as M[];
      return Object.freeze({ items: Object.freeze(rows.map(view)), total: Number(total) });
    });
  } catch (e) {
    if (e instanceof AccessDenied) return Object.freeze({ items: Object.freeze([]), total: 0 });
    throw e;
  }
}

/**
 * Runs `work`; when it fails, runs `undo` and rethrows the failure of `work`. DbAuthzAdminBackend refuses to join a
 * caller transaction, so a model write and its authz batch cannot commit together (lane decision 12).
 */
export async function undoOnFailure<T>(work: () => Promise<T>, undo: () => Promise<unknown>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    // The batch error is the one to report.
    await undo().catch(() => undefined);
    throw e;
  }
}
