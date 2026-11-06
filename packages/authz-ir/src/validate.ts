import { parseCondition } from '@spinajs/authz';
import type { ConditionOp, ConditionOperand, ParsedCondition } from '@spinajs/authz';

import { parseSubjectTypeRef } from './ir.js';
import type { CaveatParamType, IRCode, IRDiagnostic, PolicyIR, Rewrite, TypeDef, TypeName } from './ir.js';

/**
 * Reference and type checks the JSON Schema cannot express: `IR001` unknown relation, `IR002` subject type
 * not allowed, `IR003` rewrite cycle with no stored base, `IR004` caveat problem, `IR005` permission bound
 * to a missing relation. Expects schema-valid input.
 */
export function validateIR(ir: PolicyIR): IRDiagnostic[] {
  const v = new Validator(ir);
  for (const [type, def] of Object.entries(ir.types)) {
    v.relations(type, def);
    for (const [name, rewrite] of Object.entries(def.permissions)) v.rewrite(type, name, rewrite, `types.${type}.permissions.${name}`);
  }
  v.cycles();
  for (const [name, caveat] of Object.entries(ir.caveats)) checkCaveat(name, caveat.params, caveat.expr, v.out);
  for (const [name, b] of Object.entries(ir.permissions)) {
    if (!v.has(b.type, b.relation)) v.report('IR005', `permissions.${name}`, `${name} is bound to ${b.type}#${b.relation}, which does not exist`);
  }
  return v.out;
}

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

class Validator {
  readonly out: IRDiagnostic[] = [];

  constructor(private readonly ir: PolicyIR) {}

  report(code: IRCode, path: string, message: string): void {
    this.out.push({ code, path, message });
  }

  type(name: TypeName): TypeDef | undefined {
    return own(this.ir.types, name) ? this.ir.types[name] : undefined;
  }

  has(type: TypeName, name: string): boolean {
    const t = this.type(type);
    return t !== undefined && (own(t.relations, name) || own(t.permissions, name));
  }

  relations(type: TypeName, def: TypeDef): void {
    for (const [name, rel] of Object.entries(def.relations)) {
      rel.allowed.forEach((ref, i) => {
        const path = `types.${type}.relations.${name}.allowed[${i}]`;
        const s = parseSubjectTypeRef(ref);
        if (s.caveat !== undefined && !own(this.ir.caveats, s.caveat)) this.report('IR004', path, `unknown caveat ${s.caveat}`);
        if (s.wildcard && s.type.includes('#')) this.report('IR002', path, 'a subject set cannot be a wildcard');
        else if (s.relation !== undefined && !this.has(s.type, s.relation)) this.report('IR002', path, `subject set ${s.type}#${s.relation} names no relation`);
        else if (s.relation !== undefined && rel.source.kind === 'column') this.report('IR002', path, 'a column holds one object, never a subject set');
      });
    }
  }

  rewrite(type: TypeName, self: string, r: Rewrite, path: string): void {
    if ('this' in r) {
      if (!own(this.type(type)!.relations, self)) this.report('IR001', path, `${type}#${self} reads its stored tuples, but ${self} is not a relation`);
    } else if ('computed' in r) {
      if (!this.has(type, r.computed)) this.report('IR001', path, `${type} has no relation ${r.computed}`);
    } else if ('tupleToUserset' in r) {
      this.arrow(type, r.tupleToUserset.tupleset, r.tupleToUserset.computed, path);
    } else if ('union' in r || 'intersection' in r) {
      const items = 'union' in r ? r.union : r.intersection;
      const key = 'union' in r ? 'union' : 'intersection';
      items.forEach((c, i) => this.rewrite(type, self, c, `${path}.${key}[${i}]`));
    } else if ('exclusion' in r) {
      this.rewrite(type, self, r.exclusion.base, `${path}.exclusion.base`);
      this.rewrite(type, self, r.exclusion.subtract, `${path}.exclusion.subtract`);
    } else if ('caveat' in r) {
      if (!own(this.ir.caveats, r.caveat)) this.report('IR004', path, `unknown caveat ${r.caveat}`);
      this.rewrite(type, self, r.of, `${path}.of`);
    } else if ('priority' in r) {
      r.priority.forEach((p, i) => this.rewrite(type, self, p.when, `${path}.priority[${i}].when`));
    }
  }

  /** Object types a tupleset relation can name. */
  targets(type: TypeName, tupleset: string): TypeName[] {
    const rel = this.type(type)!.relations[tupleset];
    return rel.allowed.map(parseSubjectTypeRef).flatMap((s) => (s.relation === undefined && !s.wildcard && this.type(s.type) ? [s.type] : []));
  }

  private arrow(type: TypeName, tupleset: string, computed: string, path: string): void {
    if (!own(this.type(type)!.relations, tupleset)) {
      this.report('IR001', path, `tupleset ${tupleset} is not a relation of ${type}`);
      return;
    }
    const targets = this.targets(type, tupleset);
    if (targets.length === 0) this.report('IR002', path, `tupleset ${type}#${tupleset} admits no object type`);
    for (const t of targets) if (!this.has(t, computed)) this.report('IR001', path, `${t} has no relation ${computed}`);
  }

  /** IR003: same-object `computed` cycles where no node can ever be satisfied from stored data. */
  cycles(): void {
    const grounded = this.groundedNodes();
    for (const [type, def] of Object.entries(this.ir.types)) {
      for (const name of Object.keys(def.permissions)) {
        if (grounded.has(`${type}#${name}`)) continue;
        const cycle = this.cycleThrough(type, name);
        if (cycle) this.report('IR003', `types.${type}.permissions.${name}`, `rewrite cycle ${cycle.join(' -> ')} has no stored base`);
      }
    }
  }

  private groundedNodes(): Set<string> {
    const grounded = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const [type, def] of Object.entries(this.ir.types)) {
        for (const [name, r] of Object.entries(def.permissions)) {
          const key = `${type}#${name}`;
          if (!grounded.has(key) && this.groundedRewrite(type, r, grounded)) {
            grounded.add(key);
            changed = true;
          }
        }
      }
    }
    return grounded;
  }

  private groundedRewrite(type: TypeName, r: Rewrite, grounded: Set<string>): boolean {
    if ('computed' in r) return !own(this.type(type)!.permissions, r.computed) || grounded.has(`${type}#${r.computed}`);
    if ('union' in r) return r.union.some((c) => this.groundedRewrite(type, c, grounded));
    if ('intersection' in r) return r.intersection.every((c) => this.groundedRewrite(type, c, grounded));
    if ('exclusion' in r) return this.groundedRewrite(type, r.exclusion.base, grounded);
    if ('caveat' in r) return this.groundedRewrite(type, r.of, grounded);
    if ('priority' in r) return r.priority.some((p) => this.groundedRewrite(type, p.when, grounded));
    return true;
  }

  private cycleThrough(type: TypeName, start: string): string[] | undefined {
    const permissions = this.type(type)!.permissions;
    const visit = (name: string, path: string[]): string[] | undefined => {
      for (const next of computedNames(permissions[name])) {
        if (next === start) return [...path, next];
        if (!own(permissions, next) || path.includes(next)) continue;
        const found = visit(next, [...path, next]);
        if (found) return found;
      }
      return undefined;
    };
    return visit(start, [start]);
  }
}

function computedNames(r: Rewrite): string[] {
  if ('computed' in r) return [r.computed];
  if ('union' in r) return r.union.flatMap(computedNames);
  if ('intersection' in r) return r.intersection.flatMap(computedNames);
  if ('exclusion' in r) return [...computedNames(r.exclusion.base), ...computedNames(r.exclusion.subtract)];
  if ('caveat' in r) return computedNames(r.of);
  if ('priority' in r) return r.priority.flatMap((p) => computedNames(p.when));
  return [];
}

// ---- IR004 ----

type Family = 'string' | 'number' | 'timestamp' | 'bool' | 'list';

const FAMILY: Record<CaveatParamType, Family> = { string: 'string', ipaddress: 'string', int: 'number', double: 'number', timestamp: 'timestamp', bool: 'bool', 'list<string>': 'list' };

const ORDER_OPS: ReadonlySet<ConditionOp> = new Set(['lt', 'lte', 'gt', 'gte']);
const PATTERN_OPS: ReadonlySet<ConditionOp> = new Set(['like', 'glob', 'wildcard']);

function checkCaveat(name: string, params: Record<string, CaveatParamType>, expr: unknown, out: IRDiagnostic[]): void {
  const path = `caveats.${name}`;
  let parsed: ParsedCondition;
  try {
    parsed = parseCondition(expr, { functions: { has: () => true }, where: path });
  } catch (e) {
    out.push({ code: 'IR004', path, message: (e as Error).message });
    return;
  }
  const param = (text: string): CaveatParamType | undefined => (own(params, text) ? params[text] : undefined);
  const walk = (p: ParsedCondition): void => {
    switch (p.kind) {
      case 'all':
      case 'any':
        p.items.forEach(walk);
        return;
      case 'not':
        walk(p.item);
        return;
      case 'fn':
        for (const ref of p.facts.refs) if (!param(ref)) out.push({ code: 'IR004', path, message: `${name}: ${ref} is not a parameter` });
        return;
      case 'cmp': {
        const problem = comparisonProblem(param(p.attr.text), p.attr.text, p.op, p.operand, param);
        if (problem) out.push({ code: 'IR004', path, message: `${name}: ${problem}` });
      }
    }
  };
  walk(parsed);
}

function comparisonProblem(type: CaveatParamType | undefined, attr: string, op: ConditionOp, operand: ConditionOperand, param: (text: string) => CaveatParamType | undefined): string | undefined {
  if (type === undefined) return `${attr} is not a parameter`;
  if (op === 'null') return undefined;
  const family = FAMILY[type];
  if (!opFits(type, family, op)) return `${op} does not apply to ${attr} (${type})`;
  if (operand.kind === 'ref') {
    const refType = param(operand.ref.text);
    if (refType === undefined) return `${operand.ref.text} is not a parameter`;
    const wanted: Family = op === 'in' || op === 'nin' ? 'list' : family;
    return FAMILY[refType] === wanted ? undefined : `${attr} (${type}) ${op} ${operand.ref.text} (${refType})`;
  }
  const v = operand.value;
  const fits = op === 'in' || op === 'nin' ? Array.isArray(v) && v.every((x) => literalFits(type, x)) : literalFits(type, v);
  return fits ? undefined : `${attr} (${type}) ${op} ${JSON.stringify(v)}`;
}

function opFits(type: CaveatParamType, family: Family, op: ConditionOp): boolean {
  if (family === 'list') return false;
  if (family === 'bool') return op === 'eq' || op === 'ne';
  if (PATTERN_OPS.has(op)) return type === 'string';
  if (ORDER_OPS.has(op)) return type !== 'ipaddress';
  return true;
}

function literalFits(type: CaveatParamType, v: unknown): boolean {
  switch (type) {
    case 'string':
    case 'ipaddress':
      return typeof v === 'string';
    case 'int':
      return Number.isInteger(v);
    case 'double':
      return typeof v === 'number';
    case 'timestamp':
      return typeof v === 'string' || typeof v === 'number';
    case 'bool':
      return typeof v === 'boolean';
    default:
      return false;
  }
}
