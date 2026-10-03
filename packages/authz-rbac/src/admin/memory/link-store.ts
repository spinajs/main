import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { AuthzAdminFailure, AuthzConfigError, SYSTEM, memoryTx } from '@spinajs/authz';
import type { AuthzTx, MemoryTx, PrincipalRef, ResourceRef } from '@spinajs/authz';

import type { LinkDef } from '../../contracts.js';
import { AdminLinkStore } from '../ports.js';
import type { AdminAssignmentStore, Page } from '../ports.js';
import { copyDate, copyPrincipalRef, copyRef, deepFreeze, normaliseTags, paged, sameRef } from '../rows.js';
import { MemoryAssignmentStore } from './assignment-store.js';

interface Row {
  readonly link: LinkDef;
  readonly hash: Buffer;
}

const hashOf = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

function copy(l: LinkDef): LinkDef {
  return deepFreeze({
    id: l.id,
    scope: copyRef(l.scope),
    expiresAt: copyDate(l.expiresAt),
    attributes: structuredClone(l.attributes ?? {}),
    ...(l.createdBy ? { createdBy: copyPrincipalRef(l.createdBy) } : {}),
  });
}

export interface MemoryLinkStoreOptions {
  readonly name?: string;
  /**
   * Links to start with, under fixed tokens (K1 and test worlds); each gets its link:<id> assignment in the
   * given store, which must then be a MemoryAssignmentStore.
   */
  readonly links?: readonly { readonly link: LinkDef; readonly token: string; readonly role: string; readonly tags?: readonly string[] }[];
}

/**
 * Links in a map, keyed by id, holding only the SHA-256 of each token. A link's grant is a normal assignment
 * of subject link:<id> in the assignment store given here, written in the same transaction. Not registered.
 */
export class MemoryLinkStore extends AdminLinkStore {
  readonly name: string;
  private readonly rows = new Map<string, Row>();
  private revision = 0;

  constructor(private readonly assignments: AdminAssignmentStore, opts: MemoryLinkStoreOptions = {}) {
    super();
    this.name = opts.name ?? 'memory';
    if (!opts.links?.length) return;
    if (!(assignments instanceof MemoryAssignmentStore)) throw new AuthzConfigError(`MemoryLinkStore: preloaded links need a MemoryAssignmentStore for their grants, got ${assignments?.constructor?.name ?? String(assignments)}`);
    for (const { link, token, role, tags } of opts.links) {
      if (this.rows.has(link.id)) throw new AuthzConfigError(`MemoryLinkStore: link ${JSON.stringify(link.id)} is preloaded twice`);
      if (typeof token !== 'string' || token === '') throw new AuthzConfigError(`MemoryLinkStore: preloaded link ${JSON.stringify(link.id)} needs a non-empty token`);
      const row = copy(link);
      this.rows.set(row.id, { link: row, hash: hashOf(token) });
      assignments.seed({ subject: { type: 'link', id: row.id }, role, scope: row.scope, tags: normaliseTags(tags), expiresAt: null }, row.createdBy ?? copyPrincipalRef(SYSTEM));
    }
  }

  async byToken(token: string): Promise<LinkDef | null> {
    if (typeof token !== 'string') return null;
    const hash = hashOf(token);
    let found: Row | undefined;
    // Every row is compared, without stopping at a match, so the time does not depend on which link matches.
    for (const row of this.rows.values()) if (timingSafeEqual(hash, row.hash)) found = row;
    return found ? copy(found.link) : null;
  }

  async byId(id: string): Promise<LinkDef | null> {
    const row = this.rows.get(id);
    return row ? copy(row.link) : null;
  }

  async create(l: Omit<LinkDef, 'id'>, grant: { role: string; tags?: readonly string[] }, actor: PrincipalRef, tx: AuthzTx): Promise<{ link: LinkDef; token: string }> {
    const undo = memoryTx(tx);
    const token = randomBytes(32).toString('base64url');
    const link = copy({ id: randomUUID(), scope: l.scope, expiresAt: l.expiresAt ?? null, attributes: l.attributes ?? {}, createdBy: actor });
    this.write(undo, link.id, { link, hash: hashOf(token) });
    await this.assignments.assign({ subject: { type: 'link', id: link.id }, role: grant.role, scope: link.scope, tags: grant.tags, expiresAt: null }, actor, tx);
    return { link: copy(link), token };
  }

  async revoke(id: string, actor: PrincipalRef, tx: AuthzTx): Promise<void> {
    const undo = memoryTx(tx);
    if (!this.rows.has(id)) throw new AuthzAdminFailure('not_found', `no link ${JSON.stringify(id)}`, 'id');
    this.write(undo, id, undefined);
    await this.dropGrants(id, actor, tx);
  }

  async update(id: string, patch: { readonly expiresAt?: Date | null; readonly attributes?: Readonly<Record<string, unknown>> }, _actor: PrincipalRef, tx: AuthzTx): Promise<LinkDef> {
    const undo = memoryTx(tx);
    const row = this.rows.get(id);
    if (!row) throw new AuthzAdminFailure('not_found', `no link ${JSON.stringify(id)}`, 'id');
    const link = copy({ ...row.link, ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}), ...(patch.attributes !== undefined ? { attributes: patch.attributes } : {}) });
    this.write(undo, id, { link, hash: row.hash });
    return copy(link);
  }

  async find(q: { readonly scope?: ResourceRef }, page?: Page): Promise<{ items: readonly LinkDef[]; total: number }> {
    const items = [...this.rows.values()].filter((r) => q.scope === undefined || sameRef(r.link.scope, q.scope)).map((r) => copy(r.link));
    return paged(items, page);
  }

  async forgetScope(scope: ResourceRef, tx: AuthzTx): Promise<readonly LinkDef[]> {
    const undo = memoryTx(tx);
    const gone = [...this.rows.values()].filter((r) => sameRef(r.link.scope, scope));
    for (const r of gone) {
      this.write(undo, r.link.id, undefined);
      await this.dropGrants(r.link.id, copyPrincipalRef(SYSTEM), tx);
    }
    return gone.map((r) => copy(r.link));
  }

  async version(): Promise<string> {
    return String(this.revision);
  }

  private async dropGrants(id: string, actor: PrincipalRef, tx: AuthzTx): Promise<void> {
    const { items } = await this.assignments.find({ subject: { type: 'link', id }, includeExpired: true, at: new Date(0) });
    for (const a of items) await this.assignments.revoke(a.id, actor, tx);
  }

  private write(undo: MemoryTx, id: string, row: Row | undefined): void {
    const before = [...this.rows.entries()];
    if (row) this.rows.set(id, row);
    else this.rows.delete(id);
    this.revision++;
    undo.onRollback(() => {
      this.rows.clear();
      for (const [k, v] of before) this.rows.set(k, v);
      this.revision++;
    });
  }
}
