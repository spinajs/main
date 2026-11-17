import { InvalidArgument } from '@spinajs/exceptions';
import { asNumber, asRecord, asString, planNode } from '@spinajs/orm';
import type { PlanNode, QueryPlan } from '@spinajs/orm';

// Keys of postgres' EXPLAIN vocabulary that go into `detail`, where the redaction sanitizes them; any other key
// (`Output`, `Function Call`, `Cache Key`, …) stays in `raw` only, which the redaction drops.
const CONDITIONS = new Set(['Hash Cond', 'Merge Cond', 'Index Cond', 'Recheck Cond', 'Join Filter', 'Filter', 'One-Time Filter']);
const KEY_LISTS = new Set(['Sort Key', 'Group Key']);

function label(plan: Record<string, unknown>): string {
  const type = asString(plan['Node Type']) ?? 'Plan';
  const relation = asString(plan['Relation Name']);
  if (relation === undefined) {
    return type;
  }

  const alias = asString(plan['Alias']);
  return alias !== undefined && alias !== relation ? `${type} on ${relation} ${alias}` : `${type} on ${relation}`;
}

function detailPart(key: string, value: unknown): string | undefined {
  if (key === 'Join Type' && typeof value === 'string') {
    return `${value} join`;
  }
  if (key === 'Index Name' && typeof value === 'string') {
    return `using ${value}`;
  }
  if (CONDITIONS.has(key) && typeof value === 'string') {
    return `${key}: ${value}`;
  }
  if (KEY_LISTS.has(key) && Array.isArray(value)) {
    return `${key}: ${value.map(String).join(', ')}`;
  }
  return undefined;
}

function node(plan: Record<string, unknown>): PlanNode {
  const parts = Object.entries(plan)
    .map(([key, value]) => detailPart(key, value))
    .filter((part): part is string => part !== undefined);
  const plans: unknown = plan['Plans'];
  const children = (Array.isArray(plans) ? plans : [])
    .map((child) => asRecord(child))
    .filter((child): child is Record<string, unknown> => child !== undefined)
    .map(node);

  return planNode(label(plan), children, {
    detail: parts.length > 0 ? parts.join('; ') : undefined,
    estimatedRows: asNumber(plan['Plan Rows']),
    estimatedCost: asNumber(plan['Total Cost']),
  });
}

/** One row whose `QUERY PLAN` cell is `[{ Plan }]`: `pg` parses the json type, other clients hand over the text. */
export function normalizePostgresPlan(rows: unknown): QueryPlan {
  const cell = asRecord(Array.isArray(rows) ? rows[0] : undefined)?.['QUERY PLAN'];
  const document: unknown = typeof cell === 'string' ? JSON.parse(cell) : cell;
  const plan = asRecord(asRecord(Array.isArray(document) ? document[0] : undefined)?.['Plan']);
  if (!plan) {
    throw new InvalidArgument('unrecognised postgres EXPLAIN (FORMAT JSON) output');
  }

  return { dialect: 'postgres', root: node(plan), raw: document };
}
