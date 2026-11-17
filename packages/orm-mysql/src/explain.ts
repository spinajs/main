import { InvalidArgument } from '@spinajs/exceptions';
import { asNumber, asRecord, asString, planNode } from '@spinajs/orm';
import type { PlanNode, QueryPlan } from '@spinajs/orm';

type Handler = (value: unknown) => PlanNode[];

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function queryBlock(block: Record<string, unknown>): PlanNode {
  const id = asNumber(block['select_id']);
  return planNode(id === undefined ? 'select' : `select #${id}`, children(block), { estimatedCost: asNumber(asRecord(block['cost_info'])?.['query_cost']) });
}

function queryBlocks(value: unknown): PlanNode[] {
  return asList(value).flatMap((entry) => {
    const block = asRecord(asRecord(entry)?.['query_block']);
    return block ? [queryBlock(block)] : [];
  });
}

// Only `attached_condition` goes into `detail`, where the redaction sanitizes it; `used_key_parts`, `ref` and
// `index_condition` stay in `raw` only, which the redaction drops.
function tableNode(value: unknown): PlanNode[] {
  const table = asRecord(value);
  if (!table) {
    return [];
  }

  const access = asString(table['access_type']);
  const key = asString(table['key']);
  const condition = asString(table['attached_condition']);
  const parts = [key === undefined ? undefined : `key ${key}`, condition === undefined ? undefined : `where ${condition}`].filter((p): p is string => p !== undefined);

  return [
    planNode(`${asString(table['table_name']) ?? '?'}${access === undefined ? '' : ` (${access})`}`, children(table), {
      detail: parts.length > 0 ? parts.join('; ') : undefined,
      estimatedRows: asNumber(table['rows_examined_per_scan']),
      estimatedCost: asNumber(asRecord(table['cost_info'])?.['prefix_cost']),
    }),
  ];
}

function operation(label: string): Handler {
  return (value) => {
    const op = asRecord(value);
    if (!op) {
      return [];
    }
    const detail = op['using_filesort'] === true ? 'using filesort' : op['using_temporary_table'] === true ? 'using temporary table' : undefined;
    return [planNode(label, children(op), { detail })];
  };
}

// The keys of MySQL's EXPLAIN document that hold plan steps; any other key is left in `raw`.
const HANDLERS = new Map<string, Handler>([
  ['table', tableNode],
  ['nested_loop', (value) => [planNode('nested loop', asList(value).flatMap((entry) => tableNode(asRecord(entry)?.['table'])))]],
  ['ordering_operation', operation('order')],
  ['grouping_operation', operation('group')],
  ['duplicates_removal', operation('distinct')],
  ['windowing', operation('window')],
  ['union_result', (value) => [planNode('union', queryBlocks(asRecord(value)?.['query_specifications']))]],
  ['buffer_result', operation('buffer')],
  ['attached_subqueries', queryBlocks],
  ['optimized_away_subqueries', queryBlocks],
  ['select_list_subqueries', queryBlocks],
  ['order_by_subqueries', queryBlocks],
  ['having_subqueries', queryBlocks],
  ['group_by_subqueries', queryBlocks],
  ['materialized_from_subquery', (value) => [planNode('materialized', queryBlocks(value))]],
  ['message', (value) => (typeof value === 'string' ? [planNode(value)] : [])],
]);

/** Children follow the document's key order, which is the order MySQL executes them in. */
function children(object: Record<string, unknown>): PlanNode[] {
  const nodes: PlanNode[] = [];
  for (const [key, value] of Object.entries(object)) {
    const handler = HANDLERS.get(key);
    if (handler) {
      nodes.push(...handler(value));
    }
  }
  return nodes;
}

/** One row whose `EXPLAIN` cell is the JSON document (`explain_json_format_version` 1, the 8.x default). */
export function normalizeMysqlPlan(rows: unknown): QueryPlan {
  const cell = asRecord(Array.isArray(rows) ? rows[0] : undefined)?.['EXPLAIN'];
  const document: unknown = typeof cell === 'string' ? JSON.parse(cell) : cell;
  const block = asRecord(asRecord(document)?.['query_block']);
  if (!block) {
    throw new InvalidArgument('unrecognised mysql EXPLAIN FORMAT=JSON output');
  }

  return { dialect: 'mysql', root: queryBlock(block), raw: document };
}
