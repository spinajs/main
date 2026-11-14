import { isDeepStrictEqual } from 'node:util';

import type { TargetName } from './case.js';

/** Every target is compared with PGlite: the postgres compilers on a real PostgreSQL ( a newer build than the CI server's 16.6 ), in process. */
export const REFERENCE: TargetName = 'pglite';

export type TargetResults = ReadonlyMap<string, unknown>;

export interface Divergence {
  readonly case: string;
  readonly target: TargetName;
  readonly reason: string;
  /** A GitHub issue number; `pending` until the user opens it. */
  readonly issue: number | 'pending';
}

export type VerdictStatus = 'agrees' | 'diverges' | 'accepted' | 'stale';

export interface Verdict {
  readonly case: string;
  readonly target: TargetName;
  readonly status: VerdictStatus;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly divergence?: Divergence;
}

const COMPARED: readonly TargetName[] = ['sqlite', 'postgres', 'mysql', 'mssql'];

function statusOf(same: boolean, listed: boolean): VerdictStatus {
  if (same) {
    return listed ? 'stale' : 'agrees';
  }
  return listed ? 'accepted' : 'diverges';
}

export function compareTargets(results: ReadonlyMap<TargetName, TargetResults>, divergences: readonly Divergence[]): Verdict[] {
  const reference = results.get(REFERENCE);
  if (!reference) {
    throw new Error(`the reference target ${REFERENCE} did not run`);
  }

  const verdicts: Verdict[] = [];
  for (const [target, byCase] of results) {
    if (target === REFERENCE) {
      continue;
    }

    for (const [name, actual] of byCase) {
      const expected = reference.get(name);
      const divergence = divergences.find((d) => d.case === name && d.target === target);
      verdicts.push({ case: name, target, status: statusOf(isDeepStrictEqual(actual, expected), divergence !== undefined), expected, actual, ...(divergence ? { divergence } : {}) });
    }
  }

  return verdicts;
}

const isIssue = (value: unknown): value is number | 'pending' => value === 'pending' || (typeof value === 'number' && Number.isInteger(value) && value > 0);
const isComparedTarget = (value: unknown): value is TargetName => typeof value === 'string' && (COMPARED as readonly string[]).includes(value);

function parseEntry(entry: unknown, index: number, caseNames: ReadonlySet<string>): Divergence {
  const e = (entry ?? {}) as Record<string, unknown>;
  const where = `divergences.json[${index}]`;

  if (typeof e.case !== 'string' || !caseNames.has(e.case)) {
    throw new Error(`${where}: case ${String(e.case)} is not in the corpus`);
  }
  if (!isComparedTarget(e.target)) {
    throw new Error(`${where}: target must be one of ${COMPARED.join(', ')}`);
  }
  if (typeof e.reason !== 'string' || e.reason.trim() === '') {
    throw new Error(`${where}: reason is required`);
  }
  if (!isIssue(e.issue)) {
    throw new Error(`${where}: issue must be a GitHub issue number or "pending"`);
  }

  return { case: e.case, target: e.target, reason: e.reason, issue: e.issue };
}

export function parseDivergences(json: unknown, caseNames: ReadonlySet<string>): Divergence[] {
  if (!Array.isArray(json)) {
    throw new Error('divergences.json must be an array');
  }

  return json.map((entry: unknown, index) => parseEntry(entry, index, caseNames));
}

export function describeVerdict(verdict: Verdict): string {
  if (verdict.status === 'stale') {
    return `${verdict.target}: listed in divergences.json (${String(verdict.divergence?.issue)}) but agrees with ${REFERENCE} now; remove the entry`;
  }

  return `${verdict.target}: expected ${JSON.stringify(verdict.expected)} (${REFERENCE}), got ${JSON.stringify(verdict.actual)}`;
}
