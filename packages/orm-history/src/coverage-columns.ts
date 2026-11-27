import type { CoverageColumns } from './coverage-table.js';
import type { HistorySpec } from './registry.js';

function records(spec: HistorySpec, column: string): boolean {
  const listed = spec.columns;
  const tracked = listed === '*' || column === spec.pk || listed.includes(column);
  return tracked && !spec.exclude.has(column) && !spec.masked.has(column);
}

/** Several models of one table record into one stream: an event is sure to hold only what each of them records. */
export function coverageColumns(specs: readonly HistorySpec[], tableColumns: readonly string[]): CoverageColumns {
  const recorded = tableColumns.filter((c) => specs.every((s) => records(s, c))).sort();
  return { recorded, skipped: tableColumns.filter((c) => !recorded.includes(c)).sort() };
}

/**
 * True when the events since the stored row may lack a column that is recorded now. A column in neither stored list
 * is new on the table: it is recorded from its first write and restarts nothing.
 */
export function restarts(stored: CoverageColumns | undefined, next: CoverageColumns): boolean {
  return stored === undefined || next.recorded.some((c) => stored.skipped.includes(c));
}

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((c, i) => c === b.at(i));

export function sameColumns(a: CoverageColumns, b: CoverageColumns): boolean {
  return same(a.recorded, b.recorded) && same(a.skipped, b.skipped);
}
