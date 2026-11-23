import { planNode } from '@spinajs/orm';
import type { PlanNode, QueryPlan } from '@spinajs/orm';
import { asPlainObject, asString, toFiniteNumber } from '@spinajs/util';

/** `SCAN t` / `SEARCH t` keep the table in the label and move the access path to the detail. */
function sqliteNode(text: string): PlanNode {
  const [operation, table, ...rest] = text.split(' ');
  if ((operation === 'SCAN' || operation === 'SEARCH') && table) {
    return planNode(`${operation} ${table}`, [], { detail: rest.length > 0 ? rest.join(' ') : undefined });
  }
  return planNode(text);
}

/** `EXPLAIN QUERY PLAN` rows arrive parents first; `parent` 0 is the statement itself. */
export function normalizeSqlitePlan(rows: unknown): QueryPlan {
  const root = planNode('QUERY PLAN');
  const byId = new Map<number, PlanNode>();

  for (const entry of Array.isArray(rows) ? rows : []) {
    const row = asPlainObject(entry);
    if (!row) {
      continue;
    }

    const node = sqliteNode(asString(row['detail']) ?? '');
    const id = toFiniteNumber(row['id']);
    if (id !== undefined) {
      byId.set(id, node);
    }
    (byId.get(toFiniteNumber(row['parent']) ?? 0) ?? root).children.push(node);
  }

  return { dialect: 'sqlite', root, raw: rows };
}
