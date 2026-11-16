import { attachRowFields } from '@spinajs/authz';
import type { AccessPlan, AuthzService, Permission, PlanTerm, Principal, ResourceType } from '@spinajs/authz';
import type { IBuilderMiddleware, IWhereBuilder, ModelBase } from '@spinajs/orm';

import type { PlanRow, PlanTermCompiler } from '../plan/index.js';
import { planFilter } from './render.js';
import { planTermCompilers } from './terms.js';

type Where = IWhereBuilder<unknown>;

export const fieldsColumn = (i: number): string => `__authz_fields_${i}`;

/** The terms a row's field set can depend on: every permit and deny term, split by its compiler's atoms(). */
function atomsOf(terms: readonly PlanTerm[], compilers: ReadonlyMap<string, PlanTermCompiler>): PlanTerm[] {
  return terms.flatMap((t) => {
    const split = compilers.get(t?.op)?.atoms?.(t.args);
    return split === undefined || split.length === 0 ? [t] : split.map((args) => ({ op: t.op, args }));
  });
}

/**
 * One condition per atom of the plan, and one for its `within` ceiling: the rows that match the same
 * conditions form one (role set, scope) group and get one decision. Empty for a plan with no terms.
 */
export function fieldConditions(plan: Extract<AccessPlan, { kind: 'filter' }>, row: PlanRow, compilers: ReadonlyMap<string, PlanTermCompiler> = planTermCompilers()): ((where: Where) => void)[] {
  const atoms = atomsOf([...(plan.permit === 'all' ? [] : plan.permit), ...plan.deny], compilers);
  const out = atoms.map((atom) => {
    const filter = planFilter({ kind: 'filter', permit: [atom], deny: [] }, row, compilers);
    return (where: Where) => (filter.kind === 'where' ? filter.apply(where) : where.where(filter.kind === 'all'));
  });
  if (plan.within !== undefined) {
    const filter = planFilter({ kind: 'filter', permit: 'all', deny: [], within: plan.within }, row, compilers);
    out.push((where) => (filter.kind === 'where' ? filter.apply(where) : where.where(filter.kind === 'all')));
  }
  return out;
}

export interface RowFieldsRequest {
  readonly service: AuthzService;
  readonly principal: Principal;
  readonly permission: Permission;
  readonly type: ResourceType;
  readonly idColumn: string;
  /** The plan is `none`: every row reads nothing, no decision needed. */
  readonly none?: boolean;
}

const on = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 't';

interface RowKey {
  readonly mask: string;
  readonly id?: string;
}

/** Groups the rows by the `__authz_fields_<i>` columns and gives each group the field set of one batched decision. */
export class RowFieldsMiddleware implements IBuilderMiddleware {
  private readonly keys: (RowKey | undefined)[] = [];

  constructor(private readonly columns: number, private readonly request: RowFieldsRequest) {}

  // Held between hooks as AccessFieldMiddleware does: afterQuery and afterHydration run in one synchronous stretch.
  afterQuery(data: unknown[]): unknown[] {
    this.keys.length = 0;
    if (!Array.isArray(data)) return data;
    for (const raw of data as Record<string, unknown>[]) {
      if (raw === null || typeof raw !== 'object' || (this.columns > 0 && !(fieldsColumn(0) in raw))) {
        this.keys.push(undefined);
        continue;
      }
      let mask = '';
      for (let i = 0; i < this.columns; i++) {
        mask += on(raw[fieldsColumn(i)]) ? '1' : '0';
        delete raw[fieldsColumn(i)];
      }
      const id = raw[this.request.idColumn];
      this.keys.push({ mask, ...(typeof id === 'string' || typeof id === 'number' || typeof id === 'bigint' ? { id: String(id) } : {}) });
    }
    return data;
  }

  modelCreation(): ModelBase | null {
    return null;
  }

  async afterHydration(models: ModelBase[]): Promise<void> {
    const groups = new Map<string, { id?: string; models: ModelBase[] }>();
    models.forEach((model, i) => {
      const key = this.keys[i];
      if (key === undefined) return;
      let group = groups.get(key.mask);
      if (group === undefined) groups.set(key.mask, (group = { models: [] }));
      group.id ??= key.id;
      group.models.push(model);
    });
    const { service, principal, permission, type, none } = this.request;
    // A group without an id has no row to decide on: it reads nothing.
    const decided = none ? [] : [...groups.values()].filter((g) => g.id !== undefined);
    const decisions = decided.length === 0 ? [] : await service.checkAll(principal, decided.map((g) => ({ permission, resource: { type, id: g.id! } })));
    const read = new Map(decided.map((g, i) => [g, decisions[i]?.allowed === true ? decisions[i].fields.read : []]));
    for (const group of groups.values()) for (const model of group.models) attachRowFields(model, read.get(group) ?? []);
  }
}
