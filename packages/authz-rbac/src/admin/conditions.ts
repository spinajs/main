import { AuthzAdminFailure } from '@spinajs/authz';

/**
 * A structural check of the Condition grammar (conditions/contracts.ts of the core), run before the
 * compile probe. The probe cannot reach the operators of a condition whose compile reads data first
 * (every scope.* condition), so without this a misspelt operator would be stored. Stand-in until L3
 * ships a condition validator; that validator should replace this file.
 */

const OPS = new Set(['eq', 'ne', 'in', 'nin', 'lt', 'lte', 'gt', 'gte', 'like', 'glob', 'wildcard', 'null']);
const ROOTS = new Set(['principal', 'actor', 'resource', 'env']);

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isScalar = (v: unknown): boolean => v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
const isRef = (v: unknown): boolean => isObject(v) && Object.keys(v).length === 1 && typeof v.ref === 'string' && v.ref !== '';

const refuse = (field: string, why: string): AuthzAdminFailure => new AuthzAdminFailure('rule_not_compilable', `${field}: ${why}`, field);

function checkAttr(path: unknown, field: string): void {
  const parts = typeof path === 'string' ? path.split('.') : [];
  if (parts.length < 2 || parts.some((p) => p === '')) throw refuse(field, `attr must be a dotted path, got ${JSON.stringify(path)}`);
  // scope.<type>.<path>: the type alone names no attribute.
  if (parts[0] === 'scope' ? parts.length < 3 : !ROOTS.has(parts[0])) throw refuse(field, `attr ${JSON.stringify(path)} must start with principal., actor., resource., env. or scope.<type>.`);
}

function checkValue(op: string, v: unknown, field: string): void {
  if (isRef(v)) return;
  const ok = op === 'null' ? typeof v === 'boolean' : op === 'in' || op === 'nin' ? Array.isArray(v) && v.every((x) => isScalar(x) || isRef(x)) : op === 'like' || op === 'glob' || op === 'wildcard' ? typeof v === 'string' : isScalar(v);
  if (!ok) throw refuse(field, `the value of ${op} has the wrong type`);
}

/** Throws rule_not_compilable with the path of the first fault (rule.when.any.1). `fnKnown` decides fn names. */
export function checkCondition(c: unknown, field: string, fnKnown: (name: string) => boolean): void {
  if (!isObject(c)) throw refuse(field, 'a condition must be an object');
  const keys = Object.keys(c);
  if ('all' in c || 'any' in c) {
    const key = 'all' in c ? 'all' : 'any';
    const list = c[key];
    if (keys.length !== 1 || !Array.isArray(list) || list.length === 0) throw refuse(field, `${key} must be the only key and a non-empty list`);
    list.forEach((x, i) => checkCondition(x, `${field}.${key}.${i}`, fnKnown));
    return;
  }
  if ('not' in c) {
    if (keys.length !== 1) throw refuse(field, 'not must be the only key');
    checkCondition(c.not, `${field}.not`, fnKnown);
    return;
  }
  if ('attr' in c) {
    checkAttr(c.attr, field);
    const ops = keys.filter((k) => k !== 'attr');
    if (ops.length !== 1 || !OPS.has(ops[0])) throw refuse(field, `an attr condition needs exactly one operator of ${[...OPS].join(' ')}, got ${ops.join(', ') || 'none'}`);
    checkValue(ops[0], c[ops[0]], field);
    return;
  }
  if ('fn' in c) {
    if (keys.some((k) => k !== 'fn' && k !== 'args') || typeof c.fn !== 'string' || c.fn === '') throw refuse(field, 'a fn condition is { fn, args? }');
    if (c.args !== undefined && !isObject(c.args)) throw refuse(field, 'fn args must be an object');
    if (!fnKnown(c.fn)) throw refuse(field, `no ConditionFunction ${JSON.stringify(c.fn)} is registered`);
    return;
  }
  throw refuse(field, 'a condition is all, any, not, attr or fn');
}
