import { randomUUID } from 'node:crypto';

import { AuthzAdminFailure, memoryTx, resourceKey } from '@spinajs/authz';
import type { AuthzTx, MemoryTx, PrincipalRef, ResourceRef } from '@spinajs/authz';

import type { Assignment, AssignmentSubject } from '../../contracts.js';
import { AdminAssignmentStore } from '../ports.js';
import type { AssignmentQuery, Page } from '../ports.js';
import { copyDate, copyPrincipalRef, copyRef, copySubject, deepFreeze, isLive, normaliseTags, paged, sameRef, subjectKey } from '../rows.js';
import { subjectKeyOf } from '../../stores/columns.js';

export interface MemoryAdminAssignmentStoreOptions {
  readonly name?: string;
  /** Rows to start with; their ids are kept. */
  readonly assignments?: readonly Assignment[];
}

const identity = (a: Pick<Assignment, 'subject' | 'role' | 'scope'>): string => `${subjectKey(a.subject)}\u0001${a.role}\u0001${resourceKey(a.scope)}`;

function copy(a: Assignment): Assignment {
  return deepFreeze({
    id: a.id,
    subject: copySubject(a.subject),
    role: a.role,
    scope: copyRef(a.scope),
    tags: normaliseTags(a.tags),
    expiresAt: copyDate(a.expiresAt),
    ...(a.grantedBy ? { grantedBy: copyPrincipalRef(a.grantedBy) } : {}),
    source: a.source,
  });
}

/**
 * Assignments in a map, written inside a MemoryAuthzAdminBackend transaction. Not registered: tests and K1
 * register one instance under AdminAssignmentStore and AssignmentStore.
 */
export class MemoryAdminAssignmentStore extends AdminAssignmentStore {
  readonly name: string;
  // Insertion order is the listing order; a re-grant keeps its place.
  private readonly rows = new Map<string, Assignment>();
  private revision = 0;

  constructor(opts: MemoryAdminAssignmentStoreOptions = {}) {
    super();
    this.name = opts.name ?? 'memory';
    for (const a of opts.assignments ?? []) this.rows.set(a.id, copy(a));
  }

  /** Setup only (MemoryLinkStore preloads, tests, K1): an upsert outside any transaction, so no rollback undoes it. */
  seed(a: Omit<Assignment, 'id' | 'source'>, actor: PrincipalRef): Assignment {
    const key = identity(a);
    const existing = [...this.rows.values()].find((r) => identity(r) === key);
    const row = copy({ id: existing?.id ?? randomUUID(), subject: a.subject, role: a.role, scope: a.scope, tags: a.tags, expiresAt: a.expiresAt ?? null, grantedBy: existing?.grantedBy ?? actor, source: 'memory' });
    this.rows.set(row.id, row);
    this.revision++;
    return copy(row);
  }

  async forSubjects(subjects: readonly AssignmentSubject[], at: Date): Promise<readonly Assignment[]> {
    const keys = new Set(subjects.map(subjectKey));
    return [...this.rows.values()].filter((a) => keys.has(subjectKey(a.subject)) && isLive(a.expiresAt, at)).map(copy);
  }

  async forSubjectKeys(keys: readonly string[], at: Date): Promise<readonly Assignment[]> {
    const wanted = new Set(keys);
    return [...this.rows.values()].filter((a) => wanted.has(subjectKeyOf(a.subject)) && isLive(a.expiresAt, at)).map(copy);
  }

  async holders(role: string, scope: ResourceRef, at: Date): Promise<readonly AssignmentSubject[]> {
    return [...this.rows.values()].filter((a) => a.role === role && sameRef(a.scope, scope) && isLive(a.expiresAt, at)).map((a) => deepFreeze(copySubject(a.subject)));
  }

  async byId(id: string): Promise<Assignment | null> {
    const a = this.rows.get(id);
    return a ? copy(a) : null;
  }

  async assign(a: Omit<Assignment, 'id' | 'source'>, actor: PrincipalRef, tx: AuthzTx): Promise<Assignment> {
    const undo = memoryTx(tx);
    const key = identity(a);
    const existing = [...this.rows.values()].find((r) => identity(r) === key);
    const row = existing ? copy({ ...existing, tags: a.tags, expiresAt: a.expiresAt ?? null }) : copy({ id: randomUUID(), subject: a.subject, role: a.role, scope: a.scope, tags: a.tags, expiresAt: a.expiresAt ?? null, grantedBy: actor, source: 'memory' });
    this.write(undo, row.id, row);
    return copy(row);
  }

  async revoke(id: string, _actor: PrincipalRef, tx: AuthzTx): Promise<void> {
    const undo = memoryTx(tx);
    if (!this.rows.has(id)) throw new AuthzAdminFailure('not_found', `no assignment ${JSON.stringify(id)}`, 'id');
    this.write(undo, id, undefined);
  }

  async update(id: string, patch: { readonly tags?: readonly string[]; readonly expiresAt?: Date | null }, _actor: PrincipalRef, tx: AuthzTx): Promise<Assignment> {
    const undo = memoryTx(tx);
    const old = this.rows.get(id);
    if (!old) throw new AuthzAdminFailure('not_found', `no assignment ${JSON.stringify(id)}`, 'id');
    const row = copy({ ...old, ...(patch.tags !== undefined ? { tags: patch.tags } : {}), ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}) });
    this.write(undo, id, row);
    return copy(row);
  }

  async find(q: AssignmentQuery, page?: Page): Promise<{ items: readonly Assignment[]; total: number }> {
    const subject = q.subject ? subjectKey(q.subject) : undefined;
    const items = [...this.rows.values()].filter((a) => (q.scope === undefined || sameRef(a.scope, q.scope)) && (subject === undefined || subjectKey(a.subject) === subject) && (q.role === undefined || a.role === q.role) && (q.includeExpired === true || isLive(a.expiresAt, q.at)));
    return paged(items.map(copy), page);
  }

  async forgetScope(scope: ResourceRef, tx: AuthzTx): Promise<readonly Assignment[]> {
    const undo = memoryTx(tx);
    const gone = [...this.rows.values()].filter((a) => sameRef(a.scope, scope));
    for (const a of gone) this.write(undo, a.id, undefined);
    return gone.map(copy);
  }

  async version(): Promise<string> {
    return String(this.revision);
  }

  /** Sets or deletes one row; a rollback restores the whole map in its old order. */
  private write(undo: MemoryTx, id: string, row: Assignment | undefined): void {
    const before = [...this.rows.entries()];
    if (row) this.rows.set(id, row);
    else this.rows.delete(id);
    this.revision++;
    undo.onRollback(() => {
      this.rows.clear();
      for (const [k, v] of before) this.rows.set(k, v);
      // Never back to an old value: a reader that saw the rolled back write must see a change again.
      this.revision++;
    });
  }
}
