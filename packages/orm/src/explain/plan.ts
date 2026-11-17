import { sanitizeSql } from './fingerprint.js';
import type { PlanNode, QueryPlan } from './types.js';

/** A node without the optional fields it has no value for, so plans compare with deep equality. */
export function planNode(label: string, children: PlanNode[] = [], extra: Omit<PlanNode, 'label' | 'children'> = {}): PlanNode {
  const node: PlanNode = { label, children };
  if (extra.detail !== undefined) {
    node.detail = extra.detail;
  }
  if (extra.estimatedRows !== undefined) {
    node.estimatedRows = extra.estimatedRows;
  }
  if (extra.estimatedCost !== undefined) {
    node.estimatedCost = extra.estimatedCost;
  }
  return node;
}

// Postgres and MySQL print a bound boolean or NULL as a bare word (`= true`, `<=> NULL`). Neither prints one after
// `IS [NOT]`, so that keyword form, like a quoted name, stays. `sanitizeSql` keeps them all for `record.sql` and fingerprints.
const BARE_CONSTANT = /`(?:[^`]|``)*`|"(?:[^"]|"")*"|\bIS\s+(?:NOT\s+)?(?:NULL|TRUE|FALSE)\b|\b(?:TRUE|FALSE|NULL)\b/gi;

function redactDetail(detail: string, ansiQuotedIdentifiers: boolean): string {
  return sanitizeSql(detail, ansiQuotedIdentifiers).replace(BARE_CONSTANT, (token) => (/^(?:true|false|null)$/i.test(token) ? '?' : token));
}

function redactNode(node: PlanNode, ansiQuotedIdentifiers: boolean): PlanNode {
  return planNode(
    node.label,
    node.children.map((child) => redactNode(child, ansiQuotedIdentifiers)),
    { detail: node.detail === undefined ? undefined : redactDetail(node.detail, ansiQuotedIdentifiers), estimatedRows: node.estimatedRows, estimatedCost: node.estimatedCost },
  );
}

/** Postgres and MySQL print bound values inside plan conditions; this keeps the shape of the plan and drops them. */
export function redactPlan(plan: QueryPlan, ansiQuotedIdentifiers: boolean): QueryPlan {
  return { dialect: plan.dialect, root: redactNode(plan.root, ansiQuotedIdentifiers), raw: null };
}
