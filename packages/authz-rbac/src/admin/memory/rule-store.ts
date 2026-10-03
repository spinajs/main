import { AuthzAdminFailure, memoryTx, resourceKey } from '@spinajs/authz';
import type { AuthzTx, MemoryTx, PrincipalRef, ResourceRef } from '@spinajs/authz';

import type { RuleDef } from '../../contracts.js';
import { AdminRuleStore } from '../ports.js';
import type { Page } from '../ports.js';
import { deepFreeze, isLive, paged, sameRef } from '../rows.js';

// structuredClone keeps Dates and drops nothing a RuleDef holds (plain data).
const copy = (r: RuleDef): RuleDef => deepFreeze(structuredClone(r));

/** Scoped rules in a map, written inside a MemoryAuthzAdminBackend transaction; holds any rule. Not registered. */
export class MemoryRuleStore extends AdminRuleStore {
  readonly name: string;
  private readonly rows = new Map<string, RuleDef>();
  private revision = 0;

  constructor(opts: { readonly name?: string; readonly rules?: readonly RuleDef[] } = {}) {
    super();
    this.name = opts.name ?? 'memory';
    for (const r of opts.rules ?? []) this.rows.set(r.id, copy(r));
  }

  async forPath(path: readonly ResourceRef[], at: Date): Promise<readonly RuleDef[]> {
    const keys = new Set(path.map(resourceKey));
    return [...this.rows.values()].filter((r) => keys.has(resourceKey(r.scope)) && isLive(r.expiresAt, at)).map(copy);
  }

  async byId(id: string): Promise<RuleDef | null> {
    const r = this.rows.get(id);
    return r ? copy(r) : null;
  }

  assertStorable(_rule: Omit<RuleDef, 'source'>): void {}

  async put(rule: Omit<RuleDef, 'source'>, _actor: PrincipalRef, tx: AuthzTx): Promise<void> {
    const undo = memoryTx(tx);
    this.write(undo, rule.id, copy({ ...rule, source: 'memory' }));
  }

  async delete(id: string, tx: AuthzTx): Promise<void> {
    const undo = memoryTx(tx);
    if (!this.rows.has(id)) throw new AuthzAdminFailure('not_found', `no rule ${JSON.stringify(id)}`, 'id');
    this.write(undo, id, undefined);
  }

  async find(q: { readonly scope?: ResourceRef }, page?: Page): Promise<{ items: readonly RuleDef[]; total: number }> {
    return paged([...this.rows.values()].filter((r) => q.scope === undefined || sameRef(r.scope, q.scope)).map(copy), page);
  }

  async forgetScope(scope: ResourceRef, tx: AuthzTx): Promise<readonly RuleDef[]> {
    const undo = memoryTx(tx);
    const gone = [...this.rows.values()].filter((r) => sameRef(r.scope, scope));
    for (const r of gone) this.write(undo, r.id, undefined);
    return gone.map(copy);
  }

  async version(): Promise<string> {
    return String(this.revision);
  }

  private write(undo: MemoryTx, id: string, row: RuleDef | undefined): void {
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
