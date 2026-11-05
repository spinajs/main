import type { Condition } from '@spinajs/authz';

import { stableStringify } from '../canonical.js';
import { GLOBAL_TYPE, parseSubjectTypeRef } from '../ir.js';
import type { CaveatDef, PolicyIR, RelationDef, Rewrite, SubjectTypeRef, TypeDef } from '../ir.js';

export interface OpenFgaWriteOptions {
  /** Throw on the first construct OpenFGA cannot express instead of exporting a stand-in. */
  strict?: boolean;
  /** The principal type of stand-in type restrictions; default 'user'. */
  subjectType?: string;
}

export interface OpenFgaWriteResult {
  dsl: string;
  /** What OpenFGA cannot express and got a stand-in (opaque parts, priority chains, caveated rewrites, condition functions). */
  warnings: string[];
}

/** OpenFGA has no `$` in type names (G21). */
export const OPENFGA_GLOBAL = 'global';
const DEFAULT_STORE = 'authz_rebac_tuple';

class Unsupported extends Error {}

/**
 * The OpenFGA DSL (schema 1.1) of the IR. What OpenFGA cannot hold rides in `# spina:` comments so `readOpenFga`
 * restores the IR exactly: relation sources, permission bindings, combine, principal narrowing, opaque refs and the
 * caveats' own JSON. A rewrite OpenFGA cannot express becomes a stand-in type restriction carrying the rewrite in a
 * `# spina:rewrite` comment: "never" and "every principal" (under a caveat or not) are exact once the matching tuples
 * are materialised, like column relations (G19); anything else is lossy, warned about, and refused under `strict`.
 */
export function writeOpenFga(ir: PolicyIR, options: OpenFgaWriteOptions = {}): OpenFgaWriteResult {
  const warnings: string[] = [];
  const skip = (what: string): void => {
    if (options.strict === true) throw new Error(`openfga export --strict: ${what}`);
    warnings.push(what);
  };
  const lines = ['model', '  schema 1.1', ''];
  const declared = Object.keys(ir.types).sort();
  const referenced = new Set<string>();
  for (const t of declared) for (const rel of Object.values(ir.types[t].relations)) for (const a of rel.allowed) referenced.add(parseSubjectTypeRef(a).type);
  for (const t of [...referenced].filter((r) => !declared.includes(r)).sort()) lines.push(`type ${typeName(t)}`);
  for (const t of declared) lines.push(...typeLines(t, ir.types[t], options.subjectType ?? 'user', skip));
  for (const name of Object.keys(ir.caveats).sort()) lines.push(...conditionLines(name, ir.caveats[name], skip));
  lines.push('', `# spina:ir ${stableStringify({ combine: ir.combine, principal: ir.principal, opaque: ir.opaque })}`);
  for (const p of Object.keys(ir.permissions).sort()) lines.push(`# spina:permission ${p} ${stableStringify(ir.permissions[p])}`);
  return { dsl: `${lines.join('\n')}\n`, warnings };
}

const typeName = (t: string): string => (t === GLOBAL_TYPE ? OPENFGA_GLOBAL : t);

function typeLines(type: string, def: TypeDef, subject: string, skip: (what: string) => void): string[] {
  const out = [type === GLOBAL_TYPE ? `type ${OPENFGA_GLOBAL} # spina:$global` : `type ${type}`];
  const names = [...new Set([...Object.keys(def.relations), ...Object.keys(def.permissions)])].sort();
  if (names.length === 0) return out;
  out.push('  relations');
  for (const name of names) {
    const rel = Object.prototype.hasOwnProperty.call(def.relations, name) ? def.relations[name] : undefined;
    const rw = Object.prototype.hasOwnProperty.call(def.permissions, name) ? def.permissions[name] : undefined;
    const source = rel === undefined ? '' : sourceComment(rel);
    if (rw === undefined) {
      out.push(`    define ${name}: ${direct(rel!.allowed)}${source}`);
      continue;
    }
    try {
      out.push(`    define ${name}: ${expression(rw, rel, false)}${source}`);
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      const exact = standIn(rw, subject);
      if (exact === undefined) skip(`${type}#${name}: ${e.message}`);
      out.push(`    define ${name}: ${exact ?? `[${subject}]`} # spina:rewrite ${stableStringify({ rewrite: rw, relation: rel })}`);
    }
  }
  return out;
}

/** The type restriction that means the same once its tuples exist: none for "never", a wildcard for "every principal". */
function standIn(r: Rewrite, subject: string): string | undefined {
  const everyone = (x: Rewrite): boolean => 'intersection' in x && x.intersection.length === 0;
  if ('priority' in r && r.priority.length === 0) return `[${subject}]`;
  if (everyone(r)) return `[${subject}:*]`;
  if ('caveat' in r && everyone(r.of)) return `[${subject}:* with ${r.caveat}]`;
  return undefined;
}

function direct(allowed: readonly SubjectTypeRef[]): string {
  return `[${allowed
    .map((a) => {
      const s = parseSubjectTypeRef(a);
      const base = `${typeName(s.type)}${s.wildcard ? ':*' : s.relation === undefined ? '' : `#${s.relation}`}`;
      return s.caveat === undefined ? base : `${base} with ${s.caveat}`;
    })
    .join(', ')}]`;
}

function sourceComment(rel: RelationDef): string {
  const { kind, ...rest } = rel.source;
  if (kind === 'tuples' && rel.source.store === DEFAULT_STORE) return '';
  return ` # spina:${kind} ${stableStringify(rest)}`;
}

function expression(r: Rewrite, rel: RelationDef | undefined, nested: boolean): string {
  const wrap = (s: string): string => (nested ? `(${s})` : s);
  if ('this' in r) {
    if (rel === undefined) throw new Unsupported('`this` without a stored relation');
    return direct(rel.allowed);
  }
  if ('computed' in r) return r.computed;
  if ('tupleToUserset' in r) return `${r.tupleToUserset.computed} from ${r.tupleToUserset.tupleset}`;
  if ('union' in r) return wrap(r.union.map((c) => expression(c, rel, true)).join(' or '));
  if ('intersection' in r && r.intersection.length > 0) return wrap(r.intersection.map((c) => expression(c, rel, true)).join(' and '));
  if ('exclusion' in r) return wrap(`${expression(r.exclusion.base, rel, true)} but not ${expression(r.exclusion.subtract, rel, true)}`);
  if ('caveat' in r) throw new Unsupported(`caveat ${r.caveat} on a rewrite (OpenFGA conditions sit on type restrictions)`);
  if ('priority' in r) throw new Unsupported('first-applicable priority chain');
  if ('opaque' in r) throw new Unsupported(`opaque ${r.opaque}`);
  throw new Unsupported('empty intersection (every principal)');
}

/** OpenFGA parameters are identifiers; the IR's are attribute paths. */
export const conditionParam = (path: string): string => path.replace(/[^A-Za-z0-9_]/g, '_');

function conditionLines(name: string, caveat: CaveatDef, skip: (what: string) => void): string[] {
  const head = `# spina:caveat ${name} ${stableStringify(caveat)}`;
  try {
    const params = Object.entries(caveat.params).map(([p, t]) => `${conditionParam(p)}: ${t}`);
    return ['', head, `condition ${name}(${params.join(', ')}) {`, `  ${cel(caveat.expr)}`, '}'];
  } catch (e) {
    if (!(e instanceof Unsupported)) throw e;
    skip(`condition ${name}: ${e.message}`);
    return ['', head];
  }
}

const CEL_OPS: Readonly<Record<string, string>> = { eq: '==', ne: '!=', lt: '<', lte: '<=', gt: '>', gte: '>=' };

function cel(c: Condition): string {
  const o = c as Readonly<Record<string, unknown>>;
  if (Array.isArray(o.all)) return (o.all as Condition[]).map((x) => `(${cel(x)})`).join(' && ');
  if (Array.isArray(o.any)) return (o.any as Condition[]).map((x) => `(${cel(x)})`).join(' || ');
  if (o.not !== undefined) return `!(${cel(o.not as Condition)})`;
  if (typeof o.fn === 'string') throw new Unsupported(`condition function ${o.fn} (spina:opaque)`);
  const attr = String(o.attr);
  const [op, value] = Object.entries(o).find(([k]) => k !== 'attr') ?? [];
  const left = conditionParam(attr);
  const right = isRef(value) ? conditionParam(value.ref) : JSON.stringify(value);
  if (op !== undefined && CEL_OPS[op] !== undefined) return `${left} ${CEL_OPS[op]} ${right}`;
  if (op === 'in') return `${left} in ${right}`;
  if (op === 'nin') return `!(${left} in ${right})`;
  throw new Unsupported(`operator ${String(op)} on ${attr}`);
}

const isRef = (v: unknown): v is { ref: string } => typeof v === 'object' && v !== null && typeof (v as { ref?: unknown }).ref === 'string';
