import { sanitizeSql } from './fingerprint.js';
import type { PlanNode, QueryPlan } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** EXPLAIN output carries numbers as JSON numbers (postgres, sqlite) or as strings (mysql `cost_info`). */
export function asNumber(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

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

function redactNode(node: PlanNode, ansiQuotedIdentifiers: boolean): PlanNode {
  return planNode(
    node.label,
    node.children.map((child) => redactNode(child, ansiQuotedIdentifiers)),
    { detail: node.detail === undefined ? undefined : sanitizeSql(node.detail, ansiQuotedIdentifiers), estimatedRows: node.estimatedRows, estimatedCost: node.estimatedCost },
  );
}

/** Postgres and MySQL print bound values inside plan conditions; this keeps the shape of the plan and drops them. */
export function redactPlan(plan: QueryPlan, ansiQuotedIdentifiers: boolean): QueryPlan {
  return { dialect: plan.dialect, root: redactNode(plan.root, ansiQuotedIdentifiers), raw: null };
}
