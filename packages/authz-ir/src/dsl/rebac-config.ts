import { GLOBAL_TYPE, parseSubjectTypeRef } from '../ir.js';
import type { PolicyIR, Rewrite } from '../ir.js';
import { OPENFGA_GLOBAL } from './openfga-write.js';

/** The `authz.rebac` config syntax (`authz-rebac`'s `NamespaceConfig` rewrite), which authz-ir does not import. */
export type RebacRewrite = string | { computed: string } | { union: RebacRewrite[] } | { intersection: RebacRewrite[] } | { exclusion: { base: RebacRewrite; subtract: RebacRewrite } };

export interface RebacConfig {
  namespaces: Record<string, { relations?: Record<string, string[]>; permissions?: Record<string, RebacRewrite> }>;
  permissions: Record<string, string>;
  /** What the ReBAC model cannot hold and was left out. */
  problems: string[];
}

class Unsupported extends Error {}

/**
 * The `authz.rebac.namespaces` and `authz.rebac.permissions` values of an IR (the import side of G19). ReBAC has no
 * caveats, wildcards, priority chains or opaque rewrites, and a name is a relation or a permission, never both:
 * those parts are listed in `problems` and left out. `$global` becomes the namespace `global`.
 */
export function irToRebacConfig(ir: PolicyIR): RebacConfig {
  const out: RebacConfig = { namespaces: {}, permissions: {}, problems: [] };
  const name = (t: string): string => (t === GLOBAL_TYPE ? OPENFGA_GLOBAL : t);
  for (const [type, def] of Object.entries(ir.types)) {
    const ns: RebacConfig['namespaces'][string] = {};
    for (const [rel, r] of Object.entries(def.relations)) {
      if (Object.prototype.hasOwnProperty.call(def.permissions, rel)) continue;
      const allowed: string[] = [];
      for (const a of r.allowed) {
        const s = parseSubjectTypeRef(a);
        if (s.wildcard || s.caveat !== undefined) out.problems.push(`${type}#${rel}: ReBAC holds no wildcard or conditional subject ${JSON.stringify(a)}`);
        else allowed.push(`${name(s.type)}${s.relation === undefined ? '' : `#${s.relation}`}`);
      }
      (ns.relations ??= {})[rel] = allowed;
    }
    for (const [perm, rw] of Object.entries(def.permissions)) {
      try {
        (ns.permissions ??= {})[perm] = rebacRewrite(rw, Object.prototype.hasOwnProperty.call(def.relations, perm));
      } catch (e) {
        if (!(e instanceof Unsupported)) throw e;
        out.problems.push(`${type}#${perm}: ${e.message}`);
      }
    }
    out.namespaces[name(type)] = ns;
  }
  for (const [p, b] of Object.entries(ir.permissions)) out.permissions[p] = `${name(b.type)}#${b.relation}`;
  return out;
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
