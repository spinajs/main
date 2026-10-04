import { evaluateResidual, resourceKey } from '@spinajs/authz';
import type { EvaluationContext, NativeFilter, Principal, RelationResolver, ResourceFilter, ResourceRef, SubjectEnv, Truth } from '@spinajs/authz';
import type { IWhereBuilder, ModelBase } from '@spinajs/orm';

import { OrmResourceAdapter } from '../../src/adapter.js';
import { compileResidual } from '../../src/compile/compiler.js';
import type { QueryOp, ResidualContext } from '../../src/compile/compiler.js';
import { asSystem } from './system.js';

export type Model = typeof ModelBase;

const pk = (row: ModelBase): string => String((row as unknown as { id: unknown }).id);

/**
 * The in-memory side: `evaluateResidual` over rows hydrated by the ORM, through the adapter's
 * `attribute`, `ancestors` and relations (so the adapter's normalisation is part of every check).
 */
export class Memory {
  readonly adapter = new OrmResourceAdapter();
  // Rows do not change within a test, so ancestors are kept across evaluations.
  private readonly ancestors = new Map<string, Promise<readonly ResourceRef[] | null>>();

  private readonly holds = new Map<string, Promise<boolean>>();

  /** `cacheRelations`: keep each relation answer per principal and row (the rows and policies of a test do not change). */
  constructor(private readonly natives: ReadonlyMap<string, NativeFilter> = new Map(), private readonly opts: { cacheRelations?: boolean } = {}) {}

  private relation(type: string, name: string): RelationResolver | undefined {
    const r = this.adapter.relations().find((x) => x.type === type && x.relation === name);
    if (!r || !this.opts.cacheRelations) return r;
    const holds = this.holds;
    return Object.assign(Object.create(r) as RelationResolver, {
      holds(principal: Principal, ref: ResourceRef, subject?: unknown): Promise<boolean> {
        const key = JSON.stringify([name, principal.type, principal.id, resourceKey(ref)]);
        let hit = holds.get(key);
        if (hit === undefined) holds.set(key, (hit = Promise.resolve(r.holds(principal, ref, subject))));
        return hit;
      },
    });
  }

  env(principal: Principal, row: ModelBase): SubjectEnv {
    return {
      principal,
      ref: this.adapter.refOf(row),
      attribute: (subject, field) => this.adapter.attribute(subject, field),
      relation: (type, name) => this.relation(type, name),
      ancestors: (ref) => {
        const key = resourceKey(ref);
        let hit = this.ancestors.get(key);
        if (hit === undefined) this.ancestors.set(key, (hit = this.adapter.ancestors(ref)));
        return hit;
      },
      native: (op) => this.natives.get(op),
      ctx: {} as EvaluationContext,
    };
  }

  truth(filter: ResourceFilter, principal: Principal, row: ModelBase): Promise<Truth> {
    return evaluateResidual(filter, row, this.env(principal, row));
  }

  /** Ids of the rows the evaluator answers TRUE for. */
  async ids(filter: ResourceFilter, principal: Principal, rows: readonly ModelBase[]): Promise<string[]> {
    const out: string[] = [];
    for (const row of rows) if ((await this.truth(filter, principal, row)) === true) out.push(pk(row));
    return out.sort();
  }
}

export async function allRows(model: Model): Promise<ModelBase[]> {
  return (await asSystem(() => (model as any).query())) as ModelBase[];
}

export function contextOf(model: Model, principal: Principal, op: QueryOp = 'read'): ResidualContext {
  return { model, principal, op };
}

/** Ids of the rows a select with the compiled residual returns (as SYSTEM, so only this residual scopes it). */
export async function sqlIds(model: Model, filter: ResourceFilter, principal: Principal, shape?: (q: IWhereBuilder<unknown>) => void): Promise<string[]> {
  const rows = (await asSystem(() => {
    const q = (model as any).query();
    compileResidual(filter, q, contextOf(model, principal));
    shape?.(q);
    return q;
  })) as ModelBase[];
  return rows.map(pk).sort();
}

export const not = (f: ResourceFilter): ResourceFilter => ({ op: 'not', arg: f });
