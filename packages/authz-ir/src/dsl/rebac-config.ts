import { GLOBAL_TYPE, parseSubjectTypeRef } from '../ir.js';
import type { CaveatDef, ParsedSubjectType, PolicyIR, Rewrite, SubjectTypeRef } from '../ir.js';
import { validateCaveats } from '../validate.js';
import { OPENFGA_GLOBAL } from './openfga-write.js';

/** The `authz.rebac` config syntax (`authz-rebac`'s `NamespaceConfig` rewrite), which authz-ir does not import. */
export type RebacRewrite = string | { computed: string } | { union: RebacRewrite[] } | { intersection: RebacRewrite[] } | { exclusion: { base: RebacRewrite; subtract: RebacRewrite } };

export interface RebacConfig {
  namespaces: Record<string, { relations?: Record<string, string[]>; permissions?: Record<string, RebacRewrite> }>;
  permissions: Record<string, string>;
  /** The `authz.rebac.caveats` value: the caveats ReBAC can hold (parameters under `env.` and `principal.` only). */
  caveats: Record<string, CaveatDef>;
  /** What the ReBAC model cannot hold and was left out. */
  problems: string[];
}

class Unsupported extends Error {}

const REBAC_CAVEAT_ROOTS = ['env.', 'principal.'];
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * The `authz.rebac` namespaces, permissions and caveats of an IR (the import side of G19). ReBAC has no wildcards,
 * priority chains, rewrite caveats or opaque rewrites, its caveats read only `env.*` and `principal.*`, and a name is a
 * relation or a permission, never both: those parts are listed in `problems` and left out. A conditional subject type
 * whose caveat cannot be held is left out whole, never kept without its caveat, and a permission that subtracts a
 * relation which lost subject types is left out too, so the config never grants more than the IR. `$global` becomes
 * the namespace `global`.
 */
export function irToRebacConfig(ir: PolicyIR): RebacConfig {
  const problems: string[] = [];
  const out: RebacConfig = { namespaces: {}, permissions: {}, caveats: heldCaveats(ir, problems), problems };
  const narrowed = new Set<string>();
  for (const [type, def] of Object.entries(ir.types)) {
    const ns: RebacConfig['namespaces'][string] = {};
    for (const [rel, r] of Object.entries(def.relations)) {
      if (!own(def.permissions, rel)) (ns.relations ??= {})[rel] = allowedOf(`${type}#${rel}`, r.allowed, ir, out, narrowed);
    }
    out.namespaces[name(type)] = ns;
  }
  const reach = new Reach(ir, narrowed);
  for (const [type, def] of Object.entries(ir.types)) {
    for (const [perm, rw] of Object.entries(def.permissions)) {
      try {
        const subtracted = reach.subtracted(type, rw);
        if (subtracted !== undefined) throw new Unsupported(`subtracts ${subtracted}, which lost subject types: it would grant more than the model`);
        (out.namespaces[name(type)].permissions ??= {})[perm] = rebacRewrite(rw, own(def.relations, perm));
      } catch (e) {
        if (!(e instanceof Unsupported)) throw e;
        problems.push(`${type}#${perm}: ${e.message}`);
      }
    }
  }
  for (const [p, b] of Object.entries(ir.permissions)) out.permissions[p] = `${name(b.type)}#${b.relation}`;
  return out;
}

const name = (t: string): string => (t === GLOBAL_TYPE ? OPENFGA_GLOBAL : t);

/** The subject types of `key` in the `with` spelling; one that cannot be held is a problem and narrows `key`. */
function allowedOf(key: string, refs: readonly SubjectTypeRef[], ir: PolicyIR, out: RebacConfig, narrowed: Set<string>): string[] {
  const allowed: string[] = [];
  for (const a of refs) {
    const s = parseSubjectTypeRef(a);
    const why = unheld(s, JSON.stringify(a), ir, out.caveats);
    if (why !== undefined) {
      out.problems.push(`${key}: ${why}`);
      narrowed.add(key);
      continue;
    }
    const shape = `${name(s.type)}${s.relation === undefined ? '' : `#${s.relation}`}`;
    allowed.push(s.caveat === undefined ? shape : `${shape} with ${s.caveat}`);
  }
  return allowed;
}

function heldCaveats(ir: PolicyIR, problems: string[]): Record<string, CaveatDef> {
  const out: Record<string, CaveatDef> = {};
  for (const [name, def] of Object.entries(ir.caveats)) {
    const outside = Object.keys(def.params).filter((p) => !REBAC_CAVEAT_ROOTS.some((r) => p.startsWith(r)));
    const invalid = validateCaveats({ [name]: def });
    if (outside.length > 0) problems.push(`caveat ${name}: ReBAC caveats read env.* and principal.* only, not ${outside.join(', ')}`);
    else if (invalid.length > 0) problems.push(`caveat ${name}: ${invalid.map((d) => d.message).join('; ')}`);
    else out[name] = structuredClone(def);
  }
  return out;
}

function unheld(s: ParsedSubjectType, text: string, ir: PolicyIR, held: Readonly<Record<string, CaveatDef>>): string | undefined {
  if (s.wildcard) return `ReBAC holds no wildcard subject ${text}`;
  if (s.caveat === undefined || own(held, s.caveat)) return undefined;
  return `${text} needs caveat ${s.caveat}, which ${own(ir.caveats, s.caveat) ? 'ReBAC cannot hold' : 'the model does not define'}`;
}

/** Which relation that lost subject types a rewrite reaches, through computed names, subject sets and arrows. */
class Reach {
  constructor(
    private readonly ir: PolicyIR,
    private readonly narrowed: ReadonlySet<string>,
  ) {}

  /** The narrowed relation under the subtract of an exclusion in `rw`, if any. */
  subtracted(type: string, rw: Rewrite): string | undefined {
    if ('exclusion' in rw) return this.rewrite(type, rw.exclusion.subtract, new Set()) ?? this.subtracted(type, rw.exclusion.base);
    for (const c of children(rw)) {
      const hit = this.subtracted(type, c);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  private rewrite(type: string, rw: Rewrite, seen: Set<string>): string | undefined {
    if ('computed' in rw) return this.name(type, rw.computed, seen);
    if ('tupleToUserset' in rw) {
      const { tupleset, computed } = rw.tupleToUserset;
      const hit = this.name(type, tupleset, seen);
      if (hit !== undefined) return hit;
      for (const t of this.subjects(type, tupleset)) {
        const behind = t.relation === undefined ? this.name(t.type, computed, seen) : undefined;
        if (behind !== undefined) return behind;
      }
      return undefined;
    }
    for (const c of children(rw)) {
      const hit = this.rewrite(type, c, seen);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  private name(type: string, name: string, seen: Set<string>): string | undefined {
    const key = `${type}#${name}`;
    if (this.narrowed.has(key)) return key;
    if (seen.has(key)) return undefined;
    seen.add(key);
    for (const s of this.subjects(type, name)) {
      const hit = s.relation === undefined ? undefined : this.name(s.type, s.relation, seen);
      if (hit !== undefined) return hit;
    }
    const def = own(this.ir.types, type) ? this.ir.types[type] : undefined;
    return def !== undefined && own(def.permissions, name) ? this.rewrite(type, def.permissions[name], seen) : undefined;
  }

  private subjects(type: string, relation: string): ParsedSubjectType[] {
    const def = own(this.ir.types, type) ? this.ir.types[type] : undefined;
    return def !== undefined && own(def.relations, relation) ? def.relations[relation].allowed.map(parseSubjectTypeRef) : [];
  }
}

function children(r: Rewrite): readonly Rewrite[] {
  if ('union' in r) return r.union;
  if ('intersection' in r) return r.intersection;
  if ('exclusion' in r) return [r.exclusion.base, r.exclusion.subtract];
  if ('caveat' in r) return [r.of];
  if ('priority' in r) return r.priority.map((p) => p.when);
  return [];
}

function rebacRewrite(r: Rewrite, stored: boolean): RebacRewrite {
  const each = (items: Rewrite[]): RebacRewrite[] => items.map((c) => rebacRewrite(c, stored));
  if ('computed' in r) return r.computed;
  if ('tupleToUserset' in r) return `${r.tupleToUserset.tupleset}->${r.tupleToUserset.computed}`;
  if ('union' in r) return { union: each(r.union) };
  if ('intersection' in r && r.intersection.length > 0) return { intersection: each(r.intersection) };
  if ('exclusion' in r) return { exclusion: { base: rebacRewrite(r.exclusion.base, stored), subtract: rebacRewrite(r.exclusion.subtract, stored) } };
  if ('this' in r) throw new Unsupported(stored ? 'a name that is both a relation and a permission' : '`this` without a stored relation');
  throw new Unsupported(`ReBAC has no ${Object.keys(r)[0]} rewrite`);
}
