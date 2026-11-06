import { parseSubjectTypeRef } from '@spinajs/authz-ir';
import type { ParsedSubjectType, PolicyIR, RelationName, Rewrite, TypeDef, TypeName } from '@spinajs/authz-ir';
import type { Permission } from '@spinajs/authz';

/** The accepting state: the principal is the object the path reached, or any principal after a wildcard. */
export const ACCEPT = '$accept';

/** A tuple shape a path consumes: `X#R@Y`, `X#R@Y#S` (subject set), `X#R@U:*` (wildcard), with an optional caveat. */
export interface Letter {
  readonly object: TypeName;
  readonly relation: RelationName;
  readonly subject: TypeName;
  readonly subjectRelation?: RelationName;
  readonly wildcard: boolean;
  readonly caveat?: string;
}

export interface Edge {
  /** A `type#name` state or `ACCEPT`. */
  readonly to: string;
  readonly via: 'direct' | 'computed' | 'ttu';
  /** The relation the edge moves to (`computed`) or reads (`direct`, `ttu`). */
  readonly type: TypeName;
  readonly relation: RelationName;
  /** The tuple the edge consumes; none for `computed` and for `self` relations. */
  readonly letter?: Letter;
  /** Reads a stored relation as a userset (not as a tupleset), so the first such edge names the holder. */
  readonly stored: boolean;
  /** Under an intersection, exclusion, caveat or priority, or through a caveated subject type. */
  readonly conditional: boolean;
}

export interface HolderRef {
  readonly kind: 'role' | 'relation' | 'public';
  readonly type: TypeName;
  readonly relation: RelationName;
  readonly role?: string;
}

export function holderKey(h: HolderRef): string {
  if (h.kind === 'role') return `role:${h.role!}@${h.type}`;
  return `${h.kind === 'public' ? 'public:' : ''}${h.type}#${h.relation}`;
}

export const letterKey = (l: Letter): string => `${l.object}#${l.relation}@${l.subject}${l.wildcard ? ':*' : ''}${l.subjectRelation === undefined ? '' : `#${l.subjectRelation}`}${l.caveat === undefined ? '' : `[${l.caveat}]`}`;

export const stateKey = (type: TypeName, name: string): string => `${type}#${name}`;

interface StateInfo {
  readonly edges: Edge[];
  readonly opaque: string[];
}

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isDirect = (a: ParsedSubjectType): boolean => a.relation === undefined && !a.wildcard;

/**
 * The rewrite graph of a `PolicyIR` read as a finite automaton (G7). States are `type#name`; letters are the
 * tuples a check walks. Recursive `parent->` rewrites are cycles of this graph, so infinite path sets stay finite
 * here. Edges mirror the reference evaluator (`authz-ir/src/eval/check.ts`): column relations only hold direct
 * subjects, a `self` tupleset stays on the same object, and wildcards end a path.
 */
export class RewriteAutomaton {
  private readonly states = new Map<string, StateInfo>();
  private readonly roles = new Map<string, string>();

  constructor(readonly ir: PolicyIR) {
    for (const role of Object.keys(ir.principal.roles).sort()) for (const r of ir.principal.roles[role]) if (!this.roles.has(stateKey(r.type, r.relation))) this.roles.set(stateKey(r.type, r.relation), role);
  }

  /** The state a permission's check starts in, or none for an unbound permission. */
  start(permission: Permission): string | undefined {
    if (!own(this.ir.permissions, permission)) return undefined;
    const b = this.ir.permissions[permission];
    return stateKey(b.type, b.relation);
  }

  edges(state: string): readonly Edge[] {
    return this.info(state).edges;
  }

  /** Names of the `opaque` rewrites in the state's own rewrite. */
  opaqueAt(state: string): readonly string[] {
    return this.info(state).opaque;
  }

  /** The holder named by the first stored relation a path reads; `public` when the path ends on a wildcard. */
  holder(read: { readonly type: TypeName; readonly relation: RelationName }, wildcard: boolean): HolderRef {
    const role = this.roles.get(stateKey(read.type, read.relation));
    if (wildcard) return { kind: 'public', type: read.type, relation: read.relation };
    return role === undefined ? { kind: 'relation', type: read.type, relation: read.relation } : { kind: 'role', type: read.type, relation: read.relation, role };
  }

  private info(state: string): StateInfo {
    let info = this.states.get(state);
    if (info === undefined) {
      info = this.build(state);
      this.states.set(state, info);
    }
    return info;
  }

  private build(state: string): StateInfo {
    const out: StateInfo = { edges: [], opaque: [] };
    const hash = state.indexOf('#');
    const typeName = state.slice(0, hash);
    const name = state.slice(hash + 1);
    const type = own(this.ir.types, typeName) ? this.ir.types[typeName] : undefined;
    if (type === undefined) return out;
    if (own(type.permissions, name)) this.rewrite(out, typeName, type, name, type.permissions[name], false);
    else if (own(type.relations, name)) this.stored(out, typeName, type, name, false);
    return out;
  }

  private rewrite(out: StateInfo, typeName: TypeName, type: TypeDef, self: RelationName, r: Rewrite, conditional: boolean): void {
    if ('this' in r) this.stored(out, typeName, type, self, conditional);
    else if ('computed' in r) out.edges.push({ to: stateKey(typeName, r.computed), via: 'computed', type: typeName, relation: r.computed, stored: false, conditional });
    else if ('tupleToUserset' in r) this.arrow(out, typeName, type, r.tupleToUserset.tupleset, r.tupleToUserset.computed, conditional);
    else if ('union' in r) for (const c of r.union) this.rewrite(out, typeName, type, self, c, conditional);
    else if ('intersection' in r) for (const c of r.intersection) this.rewrite(out, typeName, type, self, c, true);
    else if ('exclusion' in r) this.rewrite(out, typeName, type, self, r.exclusion.base, true);
    else if ('caveat' in r) this.rewrite(out, typeName, type, self, r.of, true);
    else if ('priority' in r) {
      for (const e of r.priority) if (e.then === 'permit') this.rewrite(out, typeName, type, self, e.when, true);
    } else out.opaque.push(r.opaque);
  }

  /** `this` on a stored relation: direct and wildcard subjects accept, a subject set moves to its relation. */
  private stored(out: StateInfo, typeName: TypeName, type: TypeDef, name: RelationName, conditional: boolean): void {
    if (!own(type.relations, name)) return;
    const rel = type.relations[name];
    const step = { type: typeName, relation: name, via: 'direct' as const, stored: true };
    for (const a of rel.allowed.map(parseSubjectTypeRef)) {
      const cond = conditional || a.caveat !== undefined;
      if (rel.source.kind === 'self') {
        if (isDirect(a) && a.type === typeName && a.caveat === undefined) out.edges.push({ ...step, to: ACCEPT, conditional });
        continue;
      }
      if (rel.source.kind === 'column' && (!isDirect(a) || a.caveat !== undefined)) continue;
      const letter = { object: typeName, relation: name, subject: a.type, wildcard: a.wildcard, ...(a.relation === undefined ? {} : { subjectRelation: a.relation }), ...(a.caveat === undefined ? {} : { caveat: a.caveat }) };
      if (a.relation === undefined) out.edges.push({ ...step, to: ACCEPT, letter, conditional: cond });
      else if (own(this.ir.types, a.type)) out.edges.push({ ...step, to: stateKey(a.type, a.relation), letter, conditional: cond });
    }
  }

  /** Tuple-to-userset: `computed` on every object the tupleset names; a `self` tupleset names the object itself. */
  private arrow(out: StateInfo, typeName: TypeName, type: TypeDef, tupleset: RelationName, computed: RelationName, conditional: boolean): void {
    if (!own(type.relations, tupleset)) return;
    const rel = type.relations[tupleset];
    const step = { type: typeName, relation: tupleset, via: 'ttu' as const, stored: false };
    for (const a of rel.allowed.map(parseSubjectTypeRef)) {
      if (!isDirect(a) || !own(this.ir.types, a.type)) continue;
      if (rel.source.kind === 'self') {
        if (a.type === typeName && a.caveat === undefined) out.edges.push({ ...step, to: stateKey(typeName, computed), conditional });
        continue;
      }
      if (rel.source.kind === 'column' && a.caveat !== undefined) continue;
      const letter = { object: typeName, relation: tupleset, subject: a.type, wildcard: false, ...(a.caveat === undefined ? {} : { caveat: a.caveat }) };
      out.edges.push({ ...step, to: stateKey(a.type, computed), letter, conditional: conditional || a.caveat !== undefined });
    }
  }
}
