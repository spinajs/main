import { AuditConfigError } from '@spinajs/audit';
import { isPlainObject } from '@spinajs/util';

import type { IAuditRule } from './options.js';

const segments = (path: string): string[] => path.split('/').filter((segment) => segment !== '');

function matchSegments(pattern: readonly string[], path: readonly string[]): boolean {
  if (pattern.length === 0) return path.length === 0;

  const [head, ...rest] = pattern;
  if (head === '**') {
    for (let skipped = 0; skipped <= path.length; skipped++) {
      if (matchSegments(rest, path.slice(skipped))) return true;
    }
    return false;
  }

  return path.length > 0 && (head === '*' || head === path[0]) && matchSegments(rest, path.slice(1));
}

/** `pattern` is `<METHOD or *> <path pattern>`; the path is the mounted one, route parameters as written (`:id`). */
export function matchesRoute(pattern: string, method: string, path: string): boolean {
  const [verb = '', glob = ''] = pattern.trim().split(/\s+/);
  if (verb !== '*' && verb.toUpperCase() !== method.toUpperCase()) return false;

  return matchSegments(segments(glob), segments(path));
}

const isName = (value: unknown): boolean => value === undefined || (typeof value === 'string' && value.trim() !== '');

const isRule = (value: unknown): value is IAuditRule =>
  isPlainObject(value) && typeof value.match === 'string' && value.match.trim().split(/\s+/).length === 2 && isName(value.action) && isName(value.trail);

/** The `audit.http.rules` value, checked. */
export function rulesOf(value: unknown): readonly IAuditRule[] {
  const list: unknown[] = Array.isArray(value) ? value : [];
  return list.map((rule, index) => {
    if (!isRule(rule)) {
      throw new AuditConfigError(`audit.http.rules[${index}]: match must be '<METHOD or *> <path pattern>', and action and trail, when given, a name`);
    }
    return rule;
  });
}

/** The first rule whose pattern fits wins. */
export const ruleFor = (rules: readonly IAuditRule[], method: string, path: string): IAuditRule | undefined => rules.find((rule) => matchesRoute(rule.match, method, path));
