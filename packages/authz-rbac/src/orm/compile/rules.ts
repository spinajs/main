import { AuthzConfigError, GLOBAL, parseCondition, principalKey } from '@spinajs/authz';
import type { ConditionOp, ParsedCondition, Permission, PrincipalRef, ResourceType } from '@spinajs/authz';
import type { Class } from '@spinajs/di';
import { extractModelDescriptor } from '@spinajs/orm';
import type { ModelBase } from '@spinajs/orm';

import type { ImpliedEntry } from '../../model/ladder/implies.js';
import type { CompiledLadder } from '../../model/ladder/ladders.js';
import { assignmentProblem } from '../../model/roles.js';
import type { BoundCondition, BoundRule, RbacListContext, RbacRoute } from '../../model/rules/args.js';
import { escapeLike, likeToGlob } from '../../stores/rule-sql-form.js';
import { rbacRoleScopes } from '../role-graph.js';
import type { RbacListing } from '../role-graph.js';
import { attrLookup } from './attributes.js';
import type { RbacAttrLookup, RbacScopeDefaults } from './attributes.js';
import { rbacClassForm } from './classes.js';
import { RULE_SUBJECT_TABLE, rbacDbRuleTables, storedPatternLeaves, whenApplies, whenMissing } from './db-rules.js';
import type { RbacDbRuleKind } from './db-rules.js';
import type { RbacDialectName, RbacSqlDialect } from './dialect.js';
import { UNKNOWN_SQL, all, any, constant, existsTerm, flip, inexact, neg, wrap } from './kleene.js';
import type { Bound } from './kleene.js';
import type { RbacPathSql } from './path.js';
import { rbacRouteGrant } from './route.js';
import { scopeCmpSql } from './scope-leaf.js';
import { sqliteParserDepth } from './sqlite-depth.js';
import { FALSE_SQL, RbacCollationName, RbacIdentifier, RbacOuterColumn, TRUE_SQL, ident, inList, intSql, joinSql, outer, rsql } from './sql.js';
import type { RbacSql } from './sql.js';
import { WHEN_INEXACT, storedTypeIn } from './stored-rule.js';
import type { RbacResourceField } from './stored-rule.js';

/*
 * Args v2 of `native:rbac.assignment` and `native:rbac.threshold` v1 `{ rule }` with bound config rules
 * (model/rules/args.ts) as SQL: design §6.1.2 steps 1–3 and 5–8, §12.4. The oracle is the list evaluator
 * (model/rules/native.ts), which runs the rule steps (model/rules/steps.ts) on each row.
 *
 * A contribution is what step 1 puts in `live` for a row: a live assignment of the subjects on the row's
 * path with its stored role, or a role that role implies at the same scope (not when the entry is
 * 'descendants' and the assignment is at the row itself), or the same for a config role, a constant GLOBAL
 * assignment. Each kind of contribution (stored role, contributed role, implied entry) has constant
 * properties (ladder, rank, entry tags, bypass marks), so a predicate over contributions is an EXISTS over
 * the subjects' assignments on the path with an OR over the kinds, plus constants for the config roles. The
 * rule steps become three sets: C0 (after collect), C1 (after restrict) and C2 (after caps). A rank after
 * caps is never computed: "the clamped rank reaches t" is "the rank reaches t and no matching cap clamps
 * below t", since a ladder role's closure, and what it implies, only grow with its rank.
 *
 * The row-level parts are worked out in two nested one-row derived tables (SQLite's parser stack allows few
 * levels): authz_gb reads the scope attributes the rules read and gives each rule's place on the path, its
 * condition, its faults, its `{ ref }` values and which restrict rules select the principal (ranks after
 * collect); authz_gd which caps and thresholds do (ranks after restrict) and the faults of rules whose scope
 * node is missing (they fault only where they would act, as the steps do). The flag, a count over authz_gd,
 * is 1 where the verdict holds. On Postgres, given the model's table, the flag is worked out once per class of
 * rows that agree on everything it reads, and the term looks the row's class up (classes.ts); on SQLite, and
 * where that does not apply (`classForm`), once per row. Either way the term sits under `whenFound`.
 *
 * A rule read that faults (B39) refuses the row (route FALSE, threshold TRUE), as the list evaluator does
 * where its check would throw. Narrower than the evaluator, documented and tested:
 * - a `maxRole: { ref }` attribute holding null drops in the evaluator; SQL cannot tell null from missing
 *   and refuses the row;
 * - a value-side `{ ref }` holding a list is a value in the evaluator; SQL refuses the row;
 * - condition leaves the evaluator decides and SQL cannot (a scope attribute against a pattern, an order on
 *   strings, a numeric string against a string, a stored string spelled with an escape, a `{ ref }` against
 *   another read; `resource.*` other than a wildcard or a prefix glob on a string column). In a cap or a
 *   threshold they are UNKNOWN, which applies the cap or makes the threshold deny: a cap only takes from C2
 *   and a threshold only denies more, so the term is never wider. A restrict is not monotone that way (what it
 *   drops feeds the rank selectors of later rules and the missing-node faults of later restricts and caps), so
 *   its when is read twice with those leaves forced high and low (`Bound`); the check's value lies between the
 *   two, and where they differ the row faults.
 * Anything SQL cannot express at all (a condition function, a condition the core does not parse, a rule
 * the current roles do not hold) is refused at compile time, and on SQLite a term deeper than its parser
 * stack allows (`RBAC_SQLITE_TERM_DEPTH`).
 *
 * With stored rules (`dbRules`) the flag is one WITH that reads the filtered row (or a class's representative).
 * SQLite works such a correlated table out again at every sub-query that reads it, so a list takes seconds there
 * for a few rows and a few rules; Postgres works each out once per class (or per row).
 */

/** A subject as the `authz_assignment` subject columns hold it (`''` role for a principal). */
export interface RbacSubjectColumns {
  readonly type: string;
  readonly id: string;
  readonly role: string;
}

export interface RbacRulesSqlContext {
  readonly listing: RbacListing;
  readonly args: RbacListContext;
  readonly rowType: ResourceType;
  /** With the connection's dialect. */
  readonly path: RbacPathSql;
  readonly dialect: RbacSqlDialect;
  readonly defaults: RbacScopeDefaults;
  /** The string columns `resource.<field>` reads (`rbacResourceFields`). */
  readonly fields: readonly RbacResourceField[];
  readonly now: Date;
  /** `args.subjects` as the assignment table stores them. */
  readonly subjects: readonly RbacSubjectColumns[];
  readonly table: string;
  /** The filtered model's table: on Postgres a term is then worked out once per class of its rows where it can be. */
  readonly rowTable?: string;
  /** Names the term in refusals, e.g. `native:rbac.assignment (domain "root", type 'doc')`; called only to refuse. */
  readonly where: () => string;
  /**
   * Test only (the class form's differential tests); no host and no configuration sets it. `rows`: the per-row
   * form wherever the class form would be chosen. `order`: each class's representative is its first row by the
   * model's id, ascending or descending (else any row). `keys`: called with the class key of each class form built.
   * @internal
   */
  readonly testOnly?: { readonly rows?: boolean; readonly order?: 'asc' | 'desc'; readonly keys?: (keys: readonly RbacSql[]) => void };
}

type Level = 0 | 1 | 2;

/** Where the row-level parts are read: the columns of a derived level, or computed in place (authz_gb). */
interface Row {
  col(name: string): RbacSql;
  /** The static index of the row's nearest node of `type`, NULL for none; undefined when the path has no such column. */
  nearest(type: string): RbacSql | undefined;
  /** The static index of a rule's scope node, -1 when it is none. */
  index(rule: Rule): RbacSql;
}

/** A stored contribution's assignment (the columns of `contributions`' derived table), or a config role's constant one. */
type Src = { readonly alias: string } | { readonly config: PrincipalRef };

interface Kind {
  readonly stored: string;
  readonly role: string;
  readonly entry?: ImpliedEntry;
  readonly bypassRestrict: boolean;
  readonly bypassCap: boolean;
  readonly onlyBelow: boolean;
  readonly ladder?: CompiledLadder;
  readonly rank?: number;
}

interface Read {
  readonly n: number;
  readonly type: string;
  readonly path: string;
  readonly lookup: RbacAttrLookup;
}

const readCol = (read: Read, column: 'json' | 'num' | 'present'): RbacSql => (column === 'present' ? read.lookup.present(readAlias(read)) : column === 'json' ? read.lookup.json(readAlias(read)) : read.lookup.num(readAlias(read)));

type MaxRole = { readonly kind: 'none' } | { readonly kind: 'drop' } | { readonly kind: 'const'; readonly rank: number } | { readonly kind: 'ref'; readonly read: Read };
type MinRole = { readonly kind: 'const'; readonly ladder: CompiledLadder; readonly rank: number } | { readonly kind: 'ref'; readonly read: Read; readonly ladders: readonly CompiledLadder[] };

interface Rule {
  readonly def: BoundRule;
  readonly n: number;
  readonly scope: { readonly on: RbacSql; readonly index: RbacSql };
  readonly global: boolean;
  /** Scope types other than GLOBAL its conditions and refs read: without such a node the rule is indeterminate. */
  readonly types: readonly string[];
  /** Reads of its conditions; `value`: a `{ ref }` value, which must be a scalar. */
  readonly condReads: readonly { readonly read: Read; readonly value: boolean }[];
  readonly refRead?: Read;
  /** Three-valued, over the attribute reads of authz_gb. */
  readonly when?: RbacSql;
  readonly resource?: RbacSql;
  /**
   * A threshold's when and resource as its gathering decides whether it applies at all: the resource.* leaves
   * stay a residual there, so they can never make it FALSE (Kleene with those leaves UNKNOWN).
   */
  readonly whenGate?: RbacSql;
  readonly resourceGate?: RbacSql;
  /**
   * A restrict's when with the leaves SQL cannot decide forced to the values that make it largest and smallest;
   * set only when they differ. The check's value lies between them.
   */
  readonly bounds?: { readonly hi: RbacSql; readonly lo: RbacSql };
  readonly rank?: { readonly ladder: CompiledLadder; readonly at: string; readonly op: 'lt' | 'eq' | 'gte'; readonly bound: number };
  readonly allow: { readonly triples: readonly RbacSubjectColumns[]; readonly principals: ReadonlySet<string> };
  readonly capLadder?: CompiledLadder;
  readonly max: MaxRole;
  readonly stripTags: boolean;
  readonly scopeTypes?: readonly string[];
  readonly subjectTypes?: readonly string[];
  readonly min?: MinRole;
  readonly at?: string;
}

/**
 * The most SQLite parser stack a term may take (`sqliteParserDepth`; SQLite stops at 100). The query around a
 * term takes the rest: 7 entries for a route term and 11 for a threshold term under authz-orm's NOT in the
 * tests, more where a residual nests the terms deeper (an intersect agent, several models).
 */
export const RBAC_SQLITE_TERM_DEPTH = 80;

const GB = 'authz_gb';
const GD = 'authz_gd';
// The assignment rows inside `contributions`' derived table.
const ROWS = 'authz_s';

// With stored rules the term is one WITH: the assignment rows by step (s0 after collect, s1 with what the stored
// restricts keep, s2 with what the stored caps do), the stored rules (dj, dr, dx with restrict selection, dy with
// cap and threshold selection), and the faults and denials worked out per rule (dz, dc, dt); dn counts pattern leaves.
const S0 = 'authz_s0';
const S1 = 'authz_s1';
const S2 = 'authz_s2';
const DR = 'authz_dr';
const DX = 'authz_dx';
const DY = 'authz_dy';
const DZ = 'authz_dz';
const DC = 'authz_dc';
const DT = 'authz_dt';
const DN = 'authz_dn';
// A stored rule a block is about, and the stored rules a sub-query scans.
const D = 'authz_d';
const E = 'authz_e';
const RS = 'authz_rs';

const readAlias = (read: Read): string => `authz_v${read.n}`;

const flag = (c: RbacSql): RbacSql => rsql`(${c} = 1)`;
const asFlag = (cond: RbacSql): RbacSql => (cond === TRUE_SQL ? intSql(1) : cond === FALSE_SQL ? intSql(0) : rsql`CASE WHEN ${cond} THEN 1 ELSE 0 END`);
const asThree = (cond: RbacSql): RbacSql => (cond === TRUE_SQL ? intSql(1) : cond === FALSE_SQL ? intSql(0) : rsql`CASE WHEN ${cond} THEN 1 WHEN NOT ${wrap(cond)} THEN 0 END`);
/** A three-valued condition is not FALSE: UNKNOWN never turns into access, so it counts as TRUE. */
const notFalse = (cond: RbacSql): RbacSql => (cond === TRUE_SQL || cond === UNKNOWN_SQL ? TRUE_SQL : cond === FALSE_SQL ? FALSE_SQL : rsql`(CASE WHEN NOT ${wrap(cond)} THEN 0 ELSE 1 END = 1)`);
/** The same for a column holding 1, 0 or NULL. */
const notFalseCol = (c: RbacSql): RbacSql => rsql`(${c} IS NULL OR ${c} = 1)`;
const as = (expr: RbacSql, name: string): RbacSql => rsql`${expr} AS ${ident(name)}`;

/** The same SQL, for grouping the kinds whose predicate is the same into one `role IN (...)`. */
const keyOf = (s: RbacSql): string =>
  JSON.stringify(
    s.parts.map((p) => {
      if (typeof p === 'string') return p;
      if (p instanceof RbacOuterColumn) return ['o', p.column];
      if (p instanceof RbacIdentifier) return ['i', p instanceof RbacCollationName, ...p.names];
      const v = p.value;
      return ['b', typeof v, v instanceof Date ? v.toISOString() : String(v)];
    }),
  );

const NO_FUNCTIONS = { has: () => false };

/** No character outside the BMP: JavaScript's code unit order and SQL's code point order agree on it. */
const bmp = (s: string): boolean => [...s].every((ch) => ch.codePointAt(0)! <= 0xffff);

// The evaluator's budget (engine/evaluate.ts, 8 M per evaluation): a pattern leaf charges about
// (pattern + 1) * (text + 1) UTF-16 units. Texts up to WORK / ((pattern + 1) * leaves) code points keep every
// pattern leaf of these args within WORK together (with stored rules, `leaves` counts the stored thresholds'
// patterns on the row's path too, and their bound is the same: stored-rule.ts `withinWork`); longer ones are
// UNKNOWN in SQL. The budget covers the whole
// combined residual a check evaluates (every model's permits and denies, authorizer.ts), which the SQL of one
// term cannot see: this assumes the rest of it spends less than the other 7 M. authz-orm's residual compiler
// does not mirror the budget either (compile/compiler.ts); change both together.
const WORK = 1_000_000;

/**
 * The model's columns `resource.<field>` reads as strings (authz-orm's column kind `string`: no converter,
 * a text type), each field named as its column.
 */
export function rbacResourceFields(model: Class<ModelBase>, dialect: RbacDialectName): RbacResourceField[] {
  const descriptor = extractModelDescriptor(model as never);
  const out: RbacResourceField[] = [];
  for (const c of descriptor?.Columns ?? []) {
    if (c.Converter || c.Virtual || c.Aggregate || typeof c.Name !== 'string' || c.Name === '') continue;
    const type = String(c.NativeType ?? c.Type ?? '');
    const text = dialect === 'postgres' ? ['text', 'varchar', 'character varying', 'name'].includes(type.toLowerCase()) : !type.toUpperCase().includes('INT') && /CHAR|CLOB|TEXT/.test(type.toUpperCase());
    if (text) out.push({ field: c.Name, column: c.Name });
  }
  return out;
}

/**
 * The SQL of the list terms of one args context (`RbacListContext` with bound config rules, and the stored ones
 * with `dbRules`): `route` for `native:rbac.assignment` v2, `threshold` for `native:rbac.threshold` v1 `{ rule }`,
 * `thresholdDb` for `{ db: true }`.
 * @throws AuthzConfigError for a bound rule the current roles do not hold, a
 *   condition SQL cannot follow (a function, or one the core does not parse), and on SQLite a term deeper than
 *   `RBAC_SQLITE_TERM_DEPTH` (from `route` or `threshold`, naming the rule with the deepest condition)
 */
export class RbacRulesSql {
  private readonly ceiling?: ReadonlySet<string>;
  private readonly storedRoles: readonly string[];
  private readonly config: readonly { readonly subject: PrincipalRef; readonly role: string }[];
  private readonly reads = new Map<string, Read>();
  private readonly kindsBy = new Map<string, readonly Kind[]>();
  private readonly stuck: readonly Rule[];
  private readonly restricts: readonly Rule[];
  private readonly caps: readonly Rule[];
  private readonly thresholds: readonly Rule[];
  private readonly patternLeaves: number;
  private readonly configPatternLeaves: number;
  private readonly exactResource: boolean;
  /** Scope types whose nearest node the rank parts read, each a column `nx<i>` from authz_gb on. */
  private readonly nearTypes: readonly string[];
  /** `args.dbRules`: the stored rules on the row's path apply too. */
  private readonly db: boolean;
  private readonly ladders: readonly CompiledLadder[];
  /** The term being built reads stored thresholds (`thresholdDb`). */
  private dbThresholds = false;
  private readonly defaults: RbacScopeDefaults;

  constructor(private readonly ctx: RbacRulesSqlContext) {
    const { listing, args } = ctx;
    this.db = args.dbRules;
    // The row type's node is the filtered row itself (nodes of that type further up are not read: a fault, narrower).
    const own = ctx.path.nearestIndex(ctx.rowType);
    this.defaults = ctx.defaults.withOwnRow(ctx.rowType, () => (own === undefined ? FALSE_SQL : rsql`(${own} = 0)`));
    this.ladders = listing.ladders?.ladders ?? [];
    this.ceiling = args.ceilingRoles ? new Set(args.ceilingRoles) : undefined;
    const graph = listing.roles;
    this.storedRoles = graph.names.filter((r) => this.within(r) && graph.get(r)!.assignable);
    this.config = args.config.filter((c) => this.within(c.role) && assignmentProblem(graph, c.role, GLOBAL) === undefined);
    const resourceLeaves = args.rules.filter((r) => r.kind === 'threshold' && !r.indeterminate).flatMap((r) => [r.when, r.resource].flatMap(resourceReads));
    this.patternLeaves = Math.max(1, resourceLeaves.length);
    this.configPatternLeaves = resourceLeaves.length;
    // Another resource.* leaf spends the evaluator's budget too, which SQL cannot follow: then every one is UNKNOWN.
    this.exactResource = resourceLeaves.every((l) => l);
    const stuck: Rule[] = [];
    const live: Rule[] = [];
    args.rules.forEach((def, n) => {
      const rule = this.rule(def, n);
      if (rule.scope.on === FALSE_SQL) return;
      (def.indeterminate ? stuck : live).push(rule);
    });
    this.stuck = stuck;
    this.restricts = live.filter((r) => r.def.kind === 'restrict');
    this.caps = live.filter((r) => r.def.kind === 'cap');
    this.thresholds = live.filter((r) => r.def.kind === 'threshold');
    this.nearTypes = [...new Set(live.flatMap((r) => [...(r.rank ? [r.rank.at] : []), ...(r.at !== undefined ? [r.at] : [])]))];
  }

  /** The route term (`native:rbac.assignment` v2): the route's grant passes steps 5–7 after restrict and cap. */
  route(route: RbacRoute): RbacSql {
    const { listing, args, rowType, path } = this.ctx;
    const { grant, ladder, roles } = rbacRouteGrant(listing, { permission: args.permission, route });
    if (listing.ladders !== undefined && !listing.ladders.appliesAt(grant, rowType)) return path.whenFound(FALSE_SQL);
    const routeRoles = new Set(roles);
    const graph = listing.roles;
    const reach = (k: Kind, src: Src, row: Row): RbacSql => {
      if (!routeRoles.has(k.stored)) return FALSE_SQL;
      if (!k.ladder) return constant(graph.get(k.role)?.closure.includes(grant.role) === true);
      const t = k.ladder.roles.findIndex((r) => graph.get(r)?.closure.includes(grant.role));
      return t < 0 || k.rank! < t ? FALSE_SQL : this.clampOK(k, src, t, row);
    };
    return this.term([...this.restricts, ...this.caps], 'route', (row) => {
      const needs: RbacSql[] = [];
      const madeAt = grant.grantedAt;
      // A provenance contribution holds the grant itself: it reaches the grant's role, so the holder need adds nothing.
      if (!madeAt) needs.push(this.contributions('authz_a', 2, row, (k, src) => reach(k, src, row)));
      const tag = grant.requiresTag;
      if (tag !== undefined) needs.push(this.contributions('authz_b', 2, row, (k, src) => all(k.entry ? constant(k.entry.tags.includes(tag)) : this.storedTag(src, tag), neg(this.stripped(k, src, row)))));
      if (madeAt) {
        if (ladder) {
          const needed = ladder.roles.indexOf(grant.role);
          needs.push(this.contributions('authz_a', 2, row, (k, src) => (routeRoles.has(k.stored) && k.ladder === ladder && k.rank! >= needed ? all(this.clampOK(k, src, needed, row), this.scopeTypeIn(src, madeAt)) : FALSE_SQL)));
        } else needs.push(this.contributions('authz_a', 2, row, (k, src) => all(reach(k, src, row), this.scopeTypeIn(src, madeAt))));
      }
      return all(neg(this.narrowingFault(row)), ...needs);
    });
  }

  /** The threshold term (`native:rbac.threshold` v1 `{ rule: id }`): the named threshold denies the row. */
  threshold(id: string): RbacSql {
    const own = this.thresholds.find((r) => r.def.id === id);
    const known = own !== undefined || this.ctx.args.rules.some((r) => r.id === id && r.kind === 'threshold');
    if (!known) throw this.refuse(undefined, `names no threshold rule '${id}' of its args`);
    return this.term([...this.restricts, ...this.caps, ...(own ? [own] : [])], 'threshold', (row) => any(this.narrowingFault(row), own ? this.thresholdDeny(own, row) : FALSE_SQL));
  }

  /**
   * The threshold term of the stored rules (`native:rbac.threshold` v1 `{ db: true }`): some threshold of the model's
   * DbRuleStore on the row's path denies the row (reason `{ code: 'threshold', priority: 600 }`), after restrict and
   * cap with the bound and the stored rules. Without `dbRules` no stored rule applies: only the faults of the bound ones.
   */
  thresholdDb(): RbacSql {
    this.dbThresholds = this.db;
    try {
      return this.term([...this.restricts, ...this.caps], 'threshold', (row) => any(this.narrowingFault(row), this.db ? rsql`(EXISTS (SELECT 1 FROM ${ident(DT)}))` : FALSE_SQL));
    } finally {
      this.dbThresholds = false;
    }
  }

  // ---- rules ----

  private rule(def: BoundRule, n: number): Rule {
    const { listing, path } = this.ctx;
    const ladders = listing.ladders;
    const named = (name: unknown, what: string): CompiledLadder => {
      const l = typeof name === 'string' ? ladders?.ladders.find((x) => x.name === name) : undefined;
      if (!l) throw this.stale(def, `${what} names ladder ${JSON.stringify(name)}, which the current roles do not hold`);
      return l;
    };
    const roleOn = (role: unknown, ladder: CompiledLadder, what: string): number => {
      if (typeof role !== 'string' || ladders?.ladderOf(role) !== ladder) throw this.stale(def, `${what} names ${JSON.stringify(role)}, which is no role of ladder '${ladder.name}' in the current roles`);
      return ladders.rankOf(role)!;
    };
    const scope = path.scopeAt(def.scope);
    const global = def.scope.type === GLOBAL.type && def.scope.id == null;
    const base = { def, n, scope, global, allow: { triples: [], principals: new Set<string>() }, max: { kind: 'none' } as MaxRole, stripTags: false };
    if (def.indeterminate) return { ...base, types: [], condReads: [] };

    const types = new Set<string>();
    const condReads: { read: Read; value: boolean }[] = [];
    const note = (type: string, attributePath: string, value: boolean, list?: { read: Read; value: boolean }[]): Read => {
      if (attributePath === '' || type === '') throw this.refuse(def, `reads scope.${type}.${attributePath}, which names no attribute`);
      const read = this.read(def, type, attributePath);
      list?.push({ read, value });
      if (type !== GLOBAL.type) types.add(type);
      return read;
    };
    const refRead = (ref: unknown, what: string): Read => {
      const parts = typeof (ref as { ref?: unknown })?.ref === 'string' ? (ref as { ref: string }).ref.split('.') : [];
      if (parts[0] !== 'scope' || parts.length < 3 || parts.some((p) => p === '')) throw this.refuse(def, `${what} ${JSON.stringify(ref)} is no scope.<type>.<path> ref; the request parts are bound before a list`);
      return note(parts[1], parts.slice(2).join('.'), true);
    };
    const kind = def.kind;
    if (kind !== 'restrict' && kind !== 'cap' && kind !== 'threshold') throw this.refuse(def, `has kind ${JSON.stringify(kind)}`);
    if (kind !== 'threshold' && def.resource !== undefined) throw this.refuse(def, `a ${kind} rule has a resource condition, which belongs to a threshold`);
    const when = def.when !== undefined ? this.condition(def.when, def, kind === 'threshold', (t, p, v) => note(t, p, v, condReads)) : undefined;
    const resource = def.resource !== undefined ? this.condition(def.resource, def, true, (t, p, v) => note(t, p, v, condReads)) : undefined;
    const noted = (t: string, p: string) => this.read(def, t, p);
    const gates = kind === 'threshold' ? { ...(def.when !== undefined ? { whenGate: this.condition(def.when, def, true, noted, true) } : {}), ...(def.resource !== undefined ? { resourceGate: this.condition(def.resource, def, true, noted, true) } : {}) } : {};

    let rank: Rule['rank'];
    if (def.rank) {
      const r = def.rank;
      const ladder = named(r.ladder, 'subjects.rank');
      const op = r.lt !== undefined ? 'lt' : r.eq !== undefined ? 'eq' : 'gte';
      if (typeof r.at !== 'string' || r.at === '') throw this.refuse(def, 'subjects.rank needs the scope type it reads ranks at');
      rank = { ladder, at: r.at, op, bound: roleOn(r.lt ?? r.eq ?? r.gte, ladder, `subjects.rank.${op}`) };
    }

    const rule: { -readonly [K in keyof Rule]: Rule[K] } = { ...base, types: [], condReads, ...(when ? { when } : {}), ...(resource ? { resource } : {}), ...gates, ...(rank ? { rank } : {}) };
    if (kind === 'restrict' && def.when !== undefined) {
      const hi = this.condition(def.when, def, false, noted, false, 'hi');
      const lo = this.condition(def.when, def, false, noted, false, 'lo');
      if (keyOf(hi) !== keyOf(lo)) rule.bounds = { hi, lo };
    }
    if (kind === 'restrict') {
      const triples: RbacSubjectColumns[] = [];
      const principals = new Set<string>();
      for (const s of def.allow ?? []) {
        if ('set' in s) {
          const { role, scope: at } = s.set;
          // As subjectKey compares them: a stored set reads back GLOBAL without an id and another type with one or none.
          if (role === '' || (at.type === GLOBAL.type ? at.id != null : at.id === '')) continue;
          triples.push({ type: at.type, id: at.type === GLOBAL.type ? '' : at.id ?? '', role });
        } else {
          triples.push({ type: s.type, id: s.id, role: '' });
          principals.add(principalKey({ type: s.type, id: s.id }));
        }
      }
      rule.allow = { triples, principals };
    } else if (kind === 'cap') {
      const ladder = def.ladder !== undefined ? named(def.ladder, 'ladder') : undefined;
      if (ladder) rule.capLadder = ladder;
      const max = def.maxRole;
      if (max !== undefined && !ladder) throw this.refuse(def, 'a cap with maxRole needs the ladder it caps');
      if (max === null) rule.max = { kind: 'drop' };
      else if (typeof max === 'string') rule.max = { kind: 'const', rank: roleOn(max, ladder!, 'maxRole') };
      else if (max !== undefined) rule.max = { kind: 'ref', read: (rule.refRead = refRead(max, 'maxRole')) };
      rule.stripTags = def.stripTags === true;
      const sel = def.assignments;
      if (sel?.scopeTypes) rule.scopeTypes = [...sel.scopeTypes];
      if (sel?.subjectTypes) rule.subjectTypes = [...sel.subjectTypes];
    } else {
      const min = def.minRole;
      if (typeof min === 'string') {
        const ladder = def.ladder !== undefined ? named(def.ladder, 'ladder') : ladders?.ladderOf(min);
        if (!ladder) throw this.stale(def, `minRole '${min}' is no ladder role in the current roles`);
        rule.min = { kind: 'const', ladder, rank: roleOn(min, ladder, 'minRole') };
      } else if (min !== undefined && min !== null) {
        rule.min = { kind: 'ref', read: (rule.refRead = refRead(min, 'minRole')), ladders: def.ladder !== undefined ? [named(def.ladder, 'ladder')] : ladders?.ladders ?? [] };
      } else throw this.refuse(def, 'a threshold needs minRole');
      if (def.at !== undefined) {
        if (typeof def.at !== 'string' || def.at === '') throw this.refuse(def, 'at must be a scope type');
        rule.at = def.at;
      }
    }
    rule.types = [...types];
    return rule;
  }

  private read(def: BoundRule, type: string, attributePath: string): Read {
    const key = JSON.stringify([type, attributePath]);
    let read = this.reads.get(key);
    if (!read) {
      // attr() refuses a type no reference can name; refuse it here, naming the rule.
      if (type.includes('.')) throw this.refuse(def, `reads scope type ${JSON.stringify(type)}, which no reference names`);
      let lookup: RbacAttrLookup;
      try {
        lookup = attrLookup(this.ctx.path, type, attributePath, this.defaults, this.ctx.dialect);
      } catch (e) {
        throw this.refuse(def, `cannot read scope.${type}.${attributePath}: ${e instanceof Error ? e.message : String(e)}`);
      }
      read = { n: this.reads.size, type, path: attributePath, lookup };
      this.reads.set(key, read);
    }
    return read;
  }

  // ---- conditions ----

  /** Three-valued over the attribute reads of authz_gb; each scope read is noted, for the fault guard, before anything folds. */
  private condition(c: BoundCondition, def: BoundRule, resourceOk: boolean, note: (type: string, path: string, value: boolean) => Read, residual = false, bound?: Bound): RbacSql {
    if (c === null || typeof c !== 'object' || Array.isArray(c)) throw this.refuse(def, 'has a condition that is not an object');
    const node = c as Record<string, unknown>;
    if ('const' in node) {
      if (node.const === true) return TRUE_SQL;
      if (node.const === false) return FALSE_SQL;
      if (node.const === null) return UNKNOWN_SQL;
      throw this.refuse(def, `has { const: ${JSON.stringify(node.const)} }`);
    }
    if (Array.isArray(node.all)) return all(...(node.all as BoundCondition[]).map((x) => this.condition(x, def, resourceOk, note, residual, bound)));
    if (Array.isArray(node.any)) return any(...(node.any as BoundCondition[]).map((x) => this.condition(x, def, resourceOk, note, residual, bound)));
    if (node.not !== undefined && Object.keys(node).length === 1) return neg(this.condition(node.not as BoundCondition, def, resourceOk, note, residual, flip(bound)));
    let p: ParsedCondition;
    try {
      p = parseCondition(c, { functions: NO_FUNCTIONS, where: `rule '${def.id}'` });
    } catch (e) {
      throw this.refuse(def, `has a condition SQL cannot follow (a condition function, or one the core does not parse): ${e instanceof Error ? e.message : String(e)}`);
    }
    if (p.kind !== 'cmp') throw this.refuse(def, `has a ${p.kind} condition SQL cannot follow`);
    const valueRead = (): void => {
      const ref = (p as Extract<ParsedCondition, { kind: 'cmp' }>).operand;
      if (ref.kind !== 'ref') return;
      if (ref.ref.root !== 'scope') throw this.refuse(def, `compares with ${ref.ref.text}, which the binding should have made a literal`);
      note(ref.ref.scopeType!, ref.ref.path.join('.'), true);
    };
    if (p.attr.root === 'scope') {
      const read = note(p.attr.scopeType!, p.attr.path.join('.'), false);
      if (p.operand.kind === 'ref') {
        valueRead();
        // x OR NOT x of the binding: a scalar equals itself (a value read that is no scalar faults).
        return p.op === 'eq' && p.operand.ref.text === p.attr.text ? TRUE_SQL : inexact(bound);
      }
      return scopeCmpSql(p.op, p.operand.value, { json: readCol(read, 'json'), num: readCol(read, 'num') }, this.ctx.dialect, bound);
    }
    if (p.attr.root === 'resource') {
      if (!resourceOk) throw this.refuse(def, `reads ${p.attr.text} in a condition no row can follow (only a threshold's when and resource can)`);
      if (p.operand.kind === 'ref') {
        valueRead();
        return UNKNOWN_SQL;
      }
      return residual ? UNKNOWN_SQL : this.resourceLeaf(p.op, p.operand.value, p.attr.path);
    }
    throw this.refuse(def, `reads ${p.attr.text}, which the binding should have made a constant`);
  }

  /**
   * `resource.<field>` with `wildcard`, or `glob` as a fixed prefix and one trailing `*` or `**` (the DB rules'
   * SQL form, stores/rule-sql-form.ts), on a string column: as the engine's matchers within the work budget;
   * anything else UNKNOWN.
   */
  private resourceLeaf(op: ConditionOp, lit: unknown, path: readonly string[]): RbacSql {
    if (!this.exactResource || path.length !== 1 || (op !== 'wildcard' && op !== 'glob') || typeof lit !== 'string' || lit.includes('\u0000')) return UNKNOWN_SQL;
    const field = this.ctx.fields.find((f) => f.field === path[0]);
    if (!field) return UNKNOWN_SQL;
    let like: string;
    let notLike: string | undefined;
    if (op === 'wildcard') like = escapeLike(lit).replace(/\*/g, '%');
    else {
      const star = lit.indexOf('*');
      const prefix = escapeLike(star < 0 ? lit : lit.slice(0, star));
      const tail = star < 0 ? '' : lit.slice(star);
      if (tail !== '' && tail !== '*' && tail !== '**') return UNKNOWN_SQL;
      like = tail === '' ? prefix : `${prefix}%`;
      if (tail === '*') notLike = `${prefix}%/%`;
    }
    const leaves = this.patternLeaves;
    if ((65 * lit.length + 1) * leaves > WORK) return UNKNOWN_SQL;
    // With stored rules their thresholds' patterns share the budget, and how many there are depends on the row.
    const max = this.db ? rsql`${intSql(WORK)} / (${intSql(lit.length + 1)} * ${this.leavesSql()})` : Math.floor(WORK / ((lit.length + 1) * leaves));
    const column = rsql`${outer(field.column)}`;
    if (this.ctx.dialect.name === 'sqlite') {
      const matches = all(rsql`(${column} GLOB ${likeToGlob(like)})`, notLike === undefined ? TRUE_SQL : neg(rsql`(${column} GLOB ${likeToGlob(notLike)})`));
      return rsql`(CASE WHEN typeof(${column}) = ${'text'} AND instr(${column}, char(0)) = 0 AND LENGTH(${column}) <= ${max} THEN ${matches} END)`;
    }
    const matches = all(rsql`(${column} LIKE ${like} ESCAPE ${'\\'})`, notLike === undefined ? TRUE_SQL : neg(rsql`(${column} LIKE ${notLike} ESCAPE ${'\\'})`));
    return rsql`(CASE WHEN ${column} IS NOT NULL AND LENGTH(${column}) <= ${max} THEN ${matches} END)`;
  }

  /** The resource pattern leaves a check of the row may evaluate, read from the term's WITH (leavesTable). */
  private leavesSql(): RbacSql {
    return rsql`(SELECT ${ident('n')} FROM ${ident(DN)})`;
  }

  /**
   * One row, `n`: the config thresholds' pattern leaves and the stored ones'; NULL for none (a bound that is never
   * read: a leaf being bounded counts itself, unless it is a stored rule the row skips). A table of its own, so the
   * bounds stay shallow for SQLite's parser stack.
   */
  private leavesTable(): RbacSql {
    const { path, rowType, now, dialect, args } = this.ctx;
    return rsql`SELECT NULLIF(${intSql(this.configPatternLeaves)} + ${storedPatternLeaves({ path, rowType, now, dialect, permission: args.permission })}, 0) AS ${ident('n')}${dialect.fence}`;
  }

  // ---- contributions ----

  private within(role: string): boolean {
    return this.ceiling === undefined || this.ceiling.has(role);
  }

  /** The contributions an assignment of `stored` makes: itself, then what it implies (inside the ceiling). */
  private kinds(stored: string): readonly Kind[] {
    let list = this.kindsBy.get(stored);
    if (!list) {
      const { ladders, implies } = this.ctx.listing;
      const direct: Kind = { stored, role: stored, bypassRestrict: false, bypassCap: false, onlyBelow: false, ...this.rankOf(stored, ladders) };
      const implied = (implies?.of(stored) ?? []).filter((e) => this.within(e.role)).map((e): Kind => ({ stored, role: e.role, entry: e, bypassRestrict: e.bypass.includes('restrict'), bypassCap: e.bypass.includes('cap'), onlyBelow: e.at === 'descendants', ...this.rankOf(e.role, ladders) }));
      list = [direct, ...implied];
      this.kindsBy.set(stored, list);
    }
    return list;
  }

  private rankOf(role: string, ladders: RbacListing['ladders']): { ladder?: CompiledLadder; rank?: number } {
    const ladder = ladders?.ladderOf(role);
    return ladder ? { ladder, rank: ladders!.rankOf(role)! } : {};
  }

  /**
   * Some contribution of C0, C1 or C2 meets `pred`. The subjects' assignments on the path are read in a derived
   * table holding what the predicates read of each (`pi` its static path index, NULL for none; `ar` made at the
   * row itself; `al<n>` the subject in restrict rule n's allow list), so the predicates stay shallow.
   */
  private contributions(alias: string, level: Level, row: Row, pred: (k: Kind, src: Src) => RbacSql, table?: string): RbacSql {
    const parts: RbacSql[] = [];
    if (this.ctx.subjects.length > 0) {
      const src: Src = { alias };
      const groups = new Map<string, { roles: Set<string>; sql: RbacSql }>();
      for (const r of this.storedRoles) {
        for (const k of this.kinds(r)) {
          const own = pred(k, src);
          if (own === FALSE_SQL) continue;
          const p = all(this.member(k, src, level, row), own);
          if (p === FALSE_SQL) continue;
          const key = keyOf(p);
          const group = groups.get(key);
          if (group) group.roles.add(r);
          else groups.set(key, { roles: new Set([r]), sql: p });
        }
      }
      if (groups.size > 0) {
        const which = any(...[...groups.values()].map((g) => all(this.roleIn([...g.roles], alias), g.sql)));
        const from = this.db ? rsql`${ident(table ?? [S0, S1, S2][level])}` : rsql`(${this.assignmentRows()})`;
        parts.push(existsTerm(rsql`(SELECT 1 FROM ${from} ${ident(alias)} WHERE ${which})`));
      }
    }
    for (const c of this.config) {
      const src: Src = { config: c.subject };
      for (const k of this.kinds(c.role)) {
        const own = pred(k, src);
        if (own !== FALSE_SQL) parts.push(all(this.member(k, src, level, row), own));
      }
    }
    return any(...parts);
  }

  /** The subjects' live assignments on the row's path, with what the predicates read of each. */
  private assignmentRows(): RbacSql {
    const x = (column: string) => rsql`${ident(ROWS, column)}`;
    const path = this.ctx.path;
    // With stored rules the allow lists of the stored restricts read the subject too.
    const subject = this.db ? [as(x('subject_id'), 'subject_id'), as(x('subject_role'), 'subject_role')] : [];
    const cols = [as(x('role'), 'role'), as(x('scope_type'), 'scope_type'), as(x('subject_type'), 'subject_type'), ...subject, as(x('tags'), 'tags'), as(path.pathIndex(ROWS), 'pi'), as(asFlag(path.atNode(ROWS, 0)), 'ar'), ...this.restricts.map((r) => as(asFlag(any(...r.allow.triples.map((t) => rsql`(${x('subject_type')} = ${t.type} AND ${x('subject_id')} = ${t.id} AND ${x('subject_role')} = ${t.role})`))), `al${r.n}`))];
    const subjects = any(...this.ctx.subjects.map((s) => rsql`(${x('subject_type')} = ${s.type} AND ${x('subject_id')} = ${s.id} AND ${x('subject_role')} = ${s.role})`));
    const where = all(subjects, rsql`(${x('expires_at')} IS NULL OR ${x('expires_at')} > ${this.ctx.now})`, any(...path.onPathTerms(ROWS)));
    return rsql`SELECT ${joinSql(cols, ', ')} FROM ${ident(this.ctx.table)} ${ident(ROWS)} WHERE ${where}`;
  }

  private member(k: Kind, src: Src, level: Level, row: Row): RbacSql {
    const collected = k.onlyBelow ? neg(this.atRow(src)) : TRUE_SQL;
    if (level === 0) return collected;
    const restricted = all(collected, this.keptByRestricts(k, src, row));
    if (level === 1) return restricted;
    return all(restricted, neg(this.dropsByCaps(k, src, row)), k.entry && !k.bypassCap ? this.stillImplied(k, src, row) : TRUE_SQL);
  }

  /** `assignmentProblem` as constants (`rbacRoleScopes`). */
  private roleIn(roles: readonly string[], alias: string): RbacSql {
    const scopes = rbacRoleScopes(this.ctx.listing.roles, roles);
    const role = rsql`${ident(alias, 'role')}`;
    const parts: RbacSql[] = [];
    if (scopes.anyScope.length > 0) parts.push(inList(role, scopes.anyScope));
    for (const r of scopes.scoped) parts.push(r.scopeTypes.length === 0 ? FALSE_SQL : rsql`(${role} = ${r.role} AND ${inList(rsql`${ident(alias, 'scope_type')}`, r.scopeTypes)})`);
    return any(...parts);
  }

  private atRow(src: Src): RbacSql {
    return 'config' in src ? FALSE_SQL : flag(rsql`${ident(src.alias, 'ar')}`);
  }

  private scopeTypeIn(src: Src, types: readonly string[]): RbacSql {
    if ('config' in src) return constant(types.includes(GLOBAL.type));
    return types.length === 0 ? FALSE_SQL : inList(rsql`${ident(src.alias, 'scope_type')}`, [...new Set(types)]);
  }

  /** As `subjectTypeOf`: a set's stored subject type is its scope's type. */
  private subjectTypeIn(src: Src, types: readonly string[]): RbacSql {
    if ('config' in src) return constant(types.includes(src.config.type));
    return types.length === 0 ? FALSE_SQL : inList(rsql`${ident(src.alias, 'subject_type')}`, [...new Set(types)]);
  }

  private storedTag(src: Src, tag: string): RbacSql {
    // Stored as ',a,b,'; a tag never holds ',' (normaliseTags), so a tag with one is on no stored row.
    if ('config' in src || tag.includes(',')) return FALSE_SQL;
    const tags = rsql`${ident(src.alias, 'tags')}`;
    return rsql`(${tags} IS NOT NULL AND ${this.ctx.dialect.contains(tags, rsql`${`,${tag},`}`)})`;
  }

  private anyStoredTag(src: Src): RbacSql {
    if ('config' in src) return FALSE_SQL;
    const tags = rsql`${ident(src.alias, 'tags')}`;
    return rsql`(${tags} IS NOT NULL AND ${tags} <> ${''})`;
  }

  private allowed(rule: Rule, src: Src): RbacSql {
    if ('config' in src) return constant(rule.allow.principals.has(principalKey(src.config)));
    return rule.allow.triples.length === 0 ? FALSE_SQL : flag(rsql`${ident(src.alias, `al${rule.n}`)}`);
  }

  // ---- restrict (step 2) ----

  /** Kept by the bound restricts (those before `before` in id order), and by the stored ones (before it). */
  private keptByRestricts(k: Kind, src: Src, row: Row, before?: Rule): RbacSql {
    const bound = all(...this.restricts.filter((r) => before === undefined || r.n < before.n).map((r) => neg(all(flag(row.col(`rs${r.n}`)), this.restrictDrops(r, k, src, row)))));
    return this.db ? all(bound, this.keptByStored(k, src, before)) : bound;
  }

  // ---- stored rules: restrict ----

  /**
   * Kept by the selected stored restricts (or those before the bound rule `before`): no bypass, or every such
   * restrict not allowing the subject sits at or above where the contribution was made. For an assignment row the
   * nearest such restrict is a column of the row (`xd`, `xe<n>`).
   */
  private keptByStored(k: Kind, src: Src, before?: Rule): RbacSql {
    if (k.bypassRestrict) return TRUE_SQL;
    if ('config' in src) {
      const earlier = before === undefined ? TRUE_SQL : this.storedBefore(E, before.def.id);
      return rsql`(NOT EXISTS (SELECT 1 FROM ${ident(DX)} ${ident(E)} WHERE ${all(this.storedRs(E), earlier, rsql`(${ident(E, 'ix')} <> ${intSql(this.lastIndex)})`, neg(this.allowsPrincipal(E, src.config)))}))`;
    }
    const nearest = rsql`${ident(src.alias, before === undefined ? 'xd' : `xe${before.n}`)}`;
    const pi = rsql`${ident(src.alias, 'pi')}`;
    return rsql`(${nearest} IS NULL OR (${pi} IS NOT NULL AND ${pi} <= ${nearest}))`;
  }

  private get lastIndex(): number {
    return this.ctx.path.nodes.length - 1;
  }

  private dcol(d: string, c: string): RbacSql {
    return rsql`${ident(d, c)}`;
  }

  /** Stored restrict `d` drops what it does not keep: it is selected and acts (a node, a `when` not FALSE, the rank selector). */
  private storedRs(d: string): RbacSql {
    const c = (n: string) => this.dcol(d, n);
    return all(rsql`(${c('kind')} = ${'restrict'})`, rsql`(${c('ps')} = 1)`, rsql`(${c('ix')} IS NOT NULL)`, rsql`(${c('ab')} = 0)`, whenApplies(c('wc')), rsql`(${c('rk')} = 1)`);
  }

  /** Stored restrict `d` is selected without its node: the check throws where it would drop something (B39). */
  private storedRi(d: string): RbacSql {
    const c = (n: string) => this.dcol(d, n);
    return all(rsql`(${c('kind')} = ${'restrict'})`, rsql`(${c('ps')} = 1)`, rsql`(${c('ix')} IS NOT NULL)`, rsql`(${c('ab')} = 1)`, rsql`(${c('rk')} = 1)`);
  }

  /** Stored restrict `d` is selected with a `when` SQL cannot decide: `storedRs` counts it, and the row faults where it acts. */
  private storedRu(d: string): RbacSql {
    const c = (n: string) => this.dcol(d, n);
    return all(rsql`(${c('kind')} = ${'restrict'})`, rsql`(${c('ps')} = 1)`, rsql`(${c('ix')} IS NOT NULL)`, rsql`(${c('ab')} = 0)`, rsql`(${c('wc')} = ${intSql(WHEN_INEXACT)})`, rsql`(${c('rk')} = 1)`);
  }

  /** Stored rule `d` comes before the bound rule `id` in the steps' id order. Under SQL's code point order: only when no character outside the BMP can make it differ from JavaScript's. */
  private storedBefore(d: string, id: string): RbacSql {
    if (!bmp(id)) return FALSE_SQL;
    const dialect = this.ctx.dialect;
    const did = this.dcol(d, 'id');
    return all(rsql`(${dialect.textBefore(did, rsql`CAST(${id} AS TEXT)`)})`, rsql`(${dialect.bmpOnly(did)})`);
  }

  /** The bound rule `id` comes before stored rule `d` (a bound rule goes first on an equal id). */
  private boundBefore(id: string, d: string): RbacSql {
    if (!bmp(id)) return FALSE_SQL;
    const dialect = this.ctx.dialect;
    const did = this.dcol(d, 'id');
    return all(any(rsql`(${dialect.sameText(did, rsql`CAST(${id} AS TEXT)`)})`, rsql`(${dialect.textBefore(rsql`CAST(${id} AS TEXT)`, did)})`), rsql`(${dialect.bmpOnly(did)})`);
  }

  /** Stored rule `a` comes before stored rule `b`. */
  private storedBeforeStored(a: string, b: string): RbacSql {
    const dialect = this.ctx.dialect;
    return all(rsql`(${dialect.textBefore(this.dcol(a, 'id'), this.dcol(b, 'id'))})`, rsql`(${dialect.bmpOnly(this.dcol(a, 'id'))})`, rsql`(${dialect.bmpOnly(this.dcol(b, 'id'))})`);
  }

  /**
   * Stored rule `d`'s `allow` holds the subject of assignment row `s`. A set entry at a type-only scope is no
   * entry AuthzAdmin writes (it reads a set's scope as GLOBAL or a node), and the check matches it only when the
   * definition spells the scope without an id: it allows nothing here, and `storedSimpleFault` refuses a row whose
   * subjects hold such a set.
   */
  private allowsRow(d: string, s: string): RbacSql {
    const rs = (c: string) => rsql`${ident(RS, c)}`;
    return rsql`(EXISTS (SELECT 1 FROM ${ident(RULE_SUBJECT_TABLE)} ${ident(RS)} WHERE ${rs('rule_id')} = ${this.dcol(d, 'id')} AND ${rs('list')} = ${'allow'} AND ${rs('subject_type')} = ${ident(s, 'subject_type')} AND ${rs('subject_id')} = ${ident(s, 'subject_id')} AND ${rs('subject_role')} = ${ident(s, 'subject_role')} AND (${rs('subject_role')} = ${''} OR ${rs('subject_type')} = ${GLOBAL.type} OR ${rs('subject_id')} <> ${''})))`;
  }

  private allowsPrincipal(d: string, p: PrincipalRef): RbacSql {
    const rs = (c: string) => rsql`${ident(RS, c)}`;
    return rsql`(EXISTS (SELECT 1 FROM ${ident(RULE_SUBJECT_TABLE)} ${ident(RS)} WHERE ${rs('rule_id')} = ${this.dcol(d, 'id')} AND ${rs('list')} = ${'allow'} AND ${rs('subject_type')} = ${p.type} AND ${rs('subject_id')} = ${p.id} AND ${rs('subject_role')} = ${''}))`;
  }

  /** Stored restrict `d` would drop the contribution: no bypass, not allowed, made strictly above `d`'s node. */
  private storedDrops(d: string, k: Kind, src: Src): RbacSql {
    if (k.bypassRestrict) return FALSE_SQL;
    const ix = this.dcol(d, 'ix');
    if ('config' in src) return all(neg(this.allowsPrincipal(d, src.config)), rsql`(${ix} <> ${intSql(this.lastIndex)})`);
    const pi = rsql`${ident(src.alias, 'pi')}`;
    return all(neg(this.allowsRow(d, src.alias)), neg(rsql`(${pi} IS NOT NULL AND ${pi} <= ${ix})`));
  }

  // ---- stored rules: cap ----

  /** Stored cap `d` is selected and applies (an inexact `when` applies a cap: it only takes from C2). */
  private storedCs(d: string): RbacSql {
    const c = (n: string) => this.dcol(d, n);
    return all(rsql`(${c('kind')} = ${'cap'})`, rsql`(${c('ps')} = 1)`, rsql`(${c('ab')} = 0)`, whenApplies(c('wc')), rsql`(${c('rk1')} = 1)`);
  }

  private storedCi(d: string): RbacSql {
    const c = (n: string) => this.dcol(d, n);
    return all(rsql`(${c('kind')} = ${'cap'})`, rsql`(${c('ps')} = 1)`, rsql`(${c('ab')} = 1)`, rsql`(${c('rk1')} = 1)`);
  }

  private storedTs(d: string): RbacSql {
    const c = (n: string) => this.dcol(d, n);
    return all(rsql`(${c('kind')} = ${'threshold'})`, rsql`(${c('ps')} = 1)`, rsql`(${c('rk1')} = 1)`);
  }

  /** The assignment selectors of stored cap `d` take an assignment made at `scopeType` to `subjectType`. */
  private storedCapTakes(d: string, scopeType: RbacSql, subjectType: RbacSql): RbacSql {
    const dialect = this.ctx.dialect;
    return all(storedTypeIn(this.dcol(d, 'sty'), scopeType, dialect), storedTypeIn(this.dcol(d, 'sjt'), subjectType, dialect));
  }

  private srcTypes(src: Src): { scope: RbacSql; subject: RbacSql } {
    if ('config' in src) return { scope: rsql`CAST(${GLOBAL.type} AS TEXT)`, subject: rsql`CAST(${src.config.type} AS TEXT)` };
    return { scope: rsql`${ident(src.alias, 'scope_type')}`, subject: rsql`${ident(src.alias, 'subject_type')}` };
  }

  /**
   * What the selected stored caps do to an assignment made at `scopeType` to `subjectType`: `xs` some strips tags,
   * `xp<i>` some drops on ladder i (`maxRole: null`), `xm<i>` the lowest maxRole rank on ladder i (-1 for a ref the
   * row cannot read, which faults anyway). For an assignment row these are columns of authz_s2.
   */
  private storedCapEffect(what: 'xs' | 'xp' | 'xm', ladder: number, scopeType: RbacSql, subjectType: RbacSql): RbacSql {
    const e = (c: string) => this.dcol(E, c);
    const takes = all(this.storedCs(E), this.storedCapTakes(E, scopeType, subjectType));
    if (what === 'xs') return asFlag(rsql`EXISTS (SELECT 1 FROM ${ident(DY)} ${ident(E)} WHERE ${all(takes, rsql`(${e('sp')} = 1)`)})`);
    const on = rsql`(${this.ctx.dialect.sameText(e('cl'), rsql`CAST(${this.ladders[ladder].name} AS TEXT)`)})`;
    if (what === 'xp') return asFlag(rsql`EXISTS (SELECT 1 FROM ${ident(DY)} ${ident(E)} WHERE ${all(takes, on, rsql`(${e('mk')} = 1)`)})`);
    return rsql`(SELECT MIN(CASE WHEN ${e('mx')} IS NULL THEN -1 ELSE ${e('mx')} END) FROM ${ident(DY)} ${ident(E)} WHERE ${all(takes, on, rsql`(${e('mk')} IN (2, 3))`)})`;
  }

  private capEffectOf(src: Src, what: 'xs' | 'xp' | 'xm', ladder: number): RbacSql {
    if ('config' in src) {
      const t = this.srcTypes(src);
      return this.storedCapEffect(what, ladder, t.scope, t.subject);
    }
    return rsql`${ident(src.alias, what === 'xs' ? 'xs' : `${what}${ladder}`)}`;
  }

  /** The stored caps drop the contribution: `maxRole: null` on its ladder, or a role off it reaching above the cap. */
  private storedCapDrops(k: Kind, src: Src): RbacSql {
    if (k.bypassCap) return FALSE_SQL;
    return any(
      ...this.ladders.map((l, i) => {
        if (k.ladder === l) return rsql`(${this.capEffectOf(src, 'xp', i)} = 1)`;
        const reached = this.reachedRank(k.role, l);
        if (reached === undefined) return FALSE_SQL;
        const m = this.capEffectOf(src, 'xm', i);
        return any(rsql`(${this.capEffectOf(src, 'xp', i)} = 1)`, rsql`(${m} IS NOT NULL AND ${m} < ${intSql(reached)})`);
      }),
    );
  }

  /** No selected stored cap of the contribution's ladder clamps it below `t`. */
  private storedClampOK(k: Kind, src: Src, t: number | RbacSql): RbacSql {
    if (k.bypassCap || !k.ladder) return TRUE_SQL;
    const m = this.capEffectOf(src, 'xm', this.ladders.indexOf(k.ladder));
    const tt = typeof t === 'number' ? intSql(t) : t;
    return rsql`(${m} IS NULL OR (${tt} IS NOT NULL AND ${m} >= ${tt}))`;
  }

  private storedStripped(k: Kind, src: Src): RbacSql {
    if (k.bypassCap) return FALSE_SQL;
    return rsql`(${this.capEffectOf(src, 'xs', 0)} = 1)`;
  }

  /** `acts` of `applyCaps` for stored cap `d` without its node. */
  private storedCapActs(d: string, k: Kind, src: Src): RbacSql {
    if (k.bypassCap) return FALSE_SQL;
    const t = this.srcTypes(src);
    const strips = all(rsql`(${this.dcol(d, 'sp')} = 1)`, k.entry ? constant(k.entry.tags.length > 0) : this.anyStoredTag(src));
    const ranks = any(...this.ladders.filter((l) => k.ladder === l || this.reachedRank(k.role, l) !== undefined).map((l) => rsql`(${this.ctx.dialect.sameText(this.dcol(d, 'cl'), rsql`CAST(${l.name} AS TEXT)`)})`));
    return all(this.storedCapTakes(d, t.scope, t.subject), any(strips, ranks));
  }

  // ---- stored rules: rank selectors and thresholds ----

  /**
   * Flags `h<a>`, `h<b>`: the rank of stored rule `d`'s selector (ladder `rl`, nearest `rn`) after collect (level 0)
   * or restrict (level 1) reaches its bound `rb`, and `rb + 1`; computed only for the kinds that read it.
   */
  private storedHeld(d: string, level: 0 | 1, row: Row, plusOne: boolean): RbacSql {
    const c = (n: string) => this.dcol(d, n);
    const v = plusOne ? rsql`${c('rb')} + 1` : c('rb');
    return this.contributions('authz_k', level, row, (k, src) => (k.ladder ? all(rsql`(${this.ctx.dialect.sameText(c('rl'), rsql`CAST(${k.ladder.name} AS TEXT)`)})`, rsql`(${intSql(k.rank!)} >= ${v})`, this.atOrAbove(src, c('rn'))) : FALSE_SQL));
  }

  /** `rankSelects` from the flags `storedHeld` gave: 1 or 0. */
  private storedRank(d: string, held: string, heldNext: string): RbacSql {
    const c = (n: string) => this.dcol(d, n);
    return rsql`CASE WHEN ${c('ro')} IS NULL THEN 1 WHEN ${c('ro')} = 1 THEN 1 - ${c(held)} WHEN ${c('ro')} = 2 THEN ${c(held)} * (1 - ${c(heldNext)}) ELSE ${c(held)} END`;
  }

  /** Stored threshold `d`'s deciding rank (ladder `dl`, at `at`/`nt` or the provenance types) reaches its minRole `mt`. */
  private storedMeets(d: string, row: Row): RbacSql {
    const c = (n: string) => this.dcol(d, n);
    return this.contributions('authz_m', 2, row, (k, src) => {
      if (!k.ladder) return FALSE_SQL;
      const madeAt = this.provenance(k.ladder);
      const where = any(all(rsql`(${c('at')} IS NOT NULL)`, this.atOrAbove(src, c('nt'))), all(rsql`(${c('at')} IS NULL)`, madeAt ? this.scopeTypeIn(src, madeAt) : TRUE_SQL));
      return all(rsql`(${this.ctx.dialect.sameText(c('dl'), rsql`CAST(${k.ladder.name} AS TEXT)`)})`, this.clampOK(k, src, c('mt'), row), where);
    });
  }

  /**
   * Stored threshold `d` denies the row, or the check fails on it there (step 8 and its gathering): a rule the
   * check cannot compile, a missing `when` attribute or `{ ref }` value, a selected rule without its node (a ref
   * minRole, or the rank not met), a ref minRole off the rule's ladder, or a selected rule whose when and resource
   * are not FALSE and whose deciding rank is not met.
   */
  private storedDenies(d: string, row: Row): RbacSql {
    const c = (n: string) => this.dcol(d, n);
    const active = all(rsql`(${c('ps')} = 1)`, rsql`(${c('ab')} = 0)`);
    const applies = whenApplies(c('wc'));
    const fault = any(rsql`(${c('st')} = 1)`, all(active, whenMissing(c('wc'))), all(active, applies, rsql`(${c('nf')} = 1)`));
    const unmet = any(all(rsql`(${c('ab')} = 1)`, rsql`(${c('nk')} = 1)`), all(rsql`(${c('ab')} = 0)`, applies, rsql`(${c('rr')} IS NULL OR ${c('rr')} = 1)`));
    const selected = any(all(rsql`(${c('ab')} = 1)`, rsql`(${c('nk')} = 2)`), all(rsql`(${c('ab')} = 0)`, applies, rsql`(${c('ol')} = 1)`), all(unmet, neg(this.storedMeets(d, row))));
    return all(rsql`(${c('kind')} = ${'threshold'})`, any(fault, all(this.storedTs(d), selected)));
  }

  /** The restrict rule would drop the contribution: made strictly above its node, not allowed, no bypass. */
  private restrictDrops(rule: Rule, k: Kind, src: Src, row: Row): RbacSql {
    if (k.bypassRestrict) return FALSE_SQL;
    const pi = 'config' in src ? undefined : rsql`${ident(src.alias, 'pi')}`;
    const notAbove = pi === undefined ? constant(rule.global) : rsql`(${pi} IS NOT NULL AND ${pi} <= ${row.index(rule)})`;
    return all(neg(this.allowed(rule, src)), neg(notAbove));
  }

  // ---- cap (step 3) ----

  private capMatches(rule: Rule, k: Kind, src: Src, row: Row): RbacSql {
    if (k.bypassCap) return FALSE_SQL;
    return all(flag(row.col(`cs${rule.n}`)), rule.scopeTypes ? this.scopeTypeIn(src, rule.scopeTypes) : TRUE_SQL, rule.subjectTypes ? this.subjectTypeIn(src, rule.subjectTypes) : TRUE_SQL);
  }

  private dropsByCaps(k: Kind, src: Src, row: Row): RbacSql {
    return any(
      ...this.caps.map((rule) => {
        const drops = this.capDrops(rule, k, row);
        return drops === FALSE_SQL ? FALSE_SQL : all(this.capMatches(rule, k, src, row), drops);
      }),
      this.db ? this.storedCapDrops(k, src) : FALSE_SQL,
    );
  }

  /** `applyCaps`: maxRole null drops a role of the ladder; a role off it whose closure reaches above the cap is dropped too. */
  private capDrops(rule: Rule, k: Kind, row: Row): RbacSql {
    const ladder = rule.capLadder;
    if (!ladder || rule.max.kind === 'none') return FALSE_SQL;
    if (k.ladder === ladder) return constant(rule.max.kind === 'drop');
    const reached = this.reachedRank(k.role, ladder);
    if (reached === undefined) return FALSE_SQL;
    if (rule.max.kind === 'drop') return TRUE_SQL;
    if (rule.max.kind === 'const') return constant(reached > rule.max.rank);
    const m = row.col(`m${rule.n}`);
    return rsql`(${m} IS NULL OR ${intSql(reached)} > ${m})`;
  }

  /** The highest rank on `ladder` among the roles of `role`'s closure (`reachedRank` of the steps). */
  private reachedRank(role: string, ladder: CompiledLadder): number | undefined {
    let best: number | undefined;
    for (const r of this.ctx.listing.roles.get(role)?.closure ?? []) {
      if (this.ctx.listing.ladders?.ladderOf(r) !== ladder) continue;
      const rank = this.ctx.listing.ladders.rankOf(r)!;
      if (best === undefined || rank > best) best = rank;
    }
    return best;
  }

  /** The contribution's rank after caps reaches `t` (a ladder role): its own rank does, and no matching cap of its ladder clamps below `t`. */
  private clampOK(k: Kind, src: Src, t: number | RbacSql, row: Row): RbacSql {
    const own = typeof t === 'number' ? constant(k.rank! >= t) : rsql`(${t} IS NOT NULL AND ${intSql(k.rank!)} >= ${t})`;
    const caps = this.caps.filter((r) => r.capLadder === k.ladder && (r.max.kind === 'const' || r.max.kind === 'ref'));
    return all(
      own,
      ...caps.map((rule) => {
        const below = this.capBelow(rule, t, row);
        return below === FALSE_SQL ? TRUE_SQL : neg(all(this.capMatches(rule, k, src, row), below));
      }),
      this.db ? this.storedClampOK(k, src, t) : TRUE_SQL,
    );
  }

  /** The cap's maxRole rank is below `t`; an unreadable one (a fault anyway) counts as below. */
  private capBelow(rule: Rule, t: number | RbacSql, row: Row): RbacSql {
    if (rule.max.kind === 'const' && typeof t === 'number') return constant(rule.max.rank < t);
    const m = rule.max.kind === 'const' ? intSql(rule.max.rank) : row.col(`m${rule.n}`);
    const tt = typeof t === 'number' ? intSql(t) : t;
    return rsql`(CASE WHEN ${m} IS NULL OR ${tt} IS NULL THEN 1 WHEN ${m} < ${tt} THEN 1 ELSE 0 END = 1)`;
  }

  /**
   * An implied contribution without bypass 'cap' goes with its source assignment: when a cap dropped the
   * source, or clamped it to a rank whose role no longer implies it. A source the restrict step dropped keeps
   * its rank (the cap step never saw it).
   */
  private stillImplied(k: Kind, src: Src, row: Row): RbacSql {
    const source = this.kinds(k.stored)[0];
    const kept = this.keptByRestricts(source, src, row);
    let ok = neg(this.dropsByCaps(source, src, row));
    if (source.ladder) {
      const implies = this.ctx.listing.implies;
      const u = source.ladder.roles.findIndex((r) => (implies?.of(r) ?? []).some((e) => e.role === k.role));
      ok = all(ok, u < 0 ? FALSE_SQL : this.clampOK(source, src, u, row));
    }
    return any(neg(kept), ok);
  }

  private stripped(k: Kind, src: Src, row: Row): RbacSql {
    return any(...this.caps.filter((r) => r.stripTags).map((r) => this.capMatches(r, k, src, row)), this.db ? this.storedStripped(k, src) : FALSE_SQL);
  }

  /** `acts` of `applyCaps`: what makes a cap whose scope node is missing throw. */
  private capActs(rule: Rule, k: Kind, src: Src): RbacSql {
    if (k.bypassCap) return FALSE_SQL;
    const strips = rule.stripTags ? (k.entry ? constant(k.entry.tags.length > 0) : this.anyStoredTag(src)) : FALSE_SQL;
    const ladder = rule.capLadder;
    const ranks = constant(ladder !== undefined && (k.ladder === ladder || this.reachedRank(k.role, ladder) !== undefined));
    return all(rule.scopeTypes ? this.scopeTypeIn(src, rule.scopeTypes) : TRUE_SQL, rule.subjectTypes ? this.subjectTypeIn(src, rule.subjectTypes) : TRUE_SQL, any(strips, ranks));
  }

  // ---- ranks ----

  /** `rankSelects` of the steps over C0 (restrict) or C1 (cap, threshold). */
  private rankSelects(rule: Rule, level: 0 | 1, row: Row): RbacSql {
    const r = rule.rank;
    if (!r) return TRUE_SQL;
    const held = (v: number): RbacSql => (v >= r.ladder.roles.length ? FALSE_SQL : this.contributions('authz_k', level, row, (k, src) => (k.ladder === r.ladder && k.rank! >= v ? this.atOrAboveType(src, r.at, row) : FALSE_SQL)));
    if (r.op === 'lt') return neg(held(r.bound));
    if (r.op === 'eq') return all(held(r.bound), neg(held(r.bound + 1)));
    return held(r.bound);
  }

  /** The contribution is made at the nearest node of `type` or above it (`rankAtNode`). */
  private atOrAboveType(src: Src, type: string, row: Row): RbacSql {
    return this.atOrAbove(src, row.nearest(type));
  }

  /** The contribution is made at the node of static index `index` or above it; `index` NULL or undefined: no such node. */
  private atOrAbove(src: Src, index: RbacSql | undefined): RbacSql {
    if (index === undefined) return FALSE_SQL;
    if ('config' in src) return rsql`(${index} IS NOT NULL)`;
    const pi = rsql`${ident(src.alias, 'pi')}`;
    return rsql`(${index} IS NOT NULL AND ${pi} IS NOT NULL AND ${pi} >= ${index})`;
  }

  // ---- faults ----

  /** Restrict and cap rules make the row's check throw: an indeterminate rule on the path, a read that faults, a rule without its node that would act. */
  private narrowingFault(row: Row): RbacSql {
    const c = (name: string, rule: Rule) => flag(row.col(`${name}${rule.n}`));
    // rx<n>: the restrict would drop what the earlier ones kept. Without its node it then throws; with bounds that
    // disagree its choice is unknown here, and matters only then.
    const restrictFault = (r: Rule) => any(all(c('o', r), neg(c('b', r)), c('f', r)), r.types.length > 0 ? all(c('ri', r), c('rx', r)) : FALSE_SQL, r.bounds ? all(c('rs', r), neg(c('rl', r)), c('rx', r)) : FALSE_SQL);
    const stored = this.db ? [this.storedSimpleFault(), rsql`(EXISTS (SELECT 1 FROM ${ident(DZ)}))`, rsql`(EXISTS (SELECT 1 FROM ${ident(DC)}))`] : [];
    return any(...this.stuck.map((r) => r.scope.on), ...this.restricts.map(restrictFault), ...this.caps.map((r) => any(all(c('o', r), neg(c('b', r)), any(c('f', r), r.max.kind === 'ref' ? all(notFalseCol(row.col(`w${r.n}`)), rsql`(${row.col(`m${r.n}`)} IS NULL)`) : FALSE_SQL)), c('ci', r))), ...stored);
  }

  /**
   * A stored restrict or cap the check fails on wherever it reads it: one it cannot compile (`st`), a selected one
   * whose `when` attribute is missing, a cap applying with a `maxRole: { ref }` that names no role of its ladder.
   * Also a restrict on the path whose `allow` holds a set at a type-only scope that the subjects hold (`allowsRow`).
   */
  private storedSimpleFault(): RbacSql {
    const e = (n: string) => this.dcol(E, n);
    const rs = (c: string) => rsql`${ident(RS, c)}`;
    const s = (c: string) => rsql`${ident(S0, c)}`;
    const active = all(rsql`(${e('ps')} = 1)`, rsql`(${e('ab')} = 0)`);
    const typeOnlySet = rsql`(EXISTS (SELECT 1 FROM ${ident(RULE_SUBJECT_TABLE)} ${ident(RS)} WHERE ${rs('rule_id')} = ${e('id')} AND ${rs('list')} = ${'allow'} AND ${rs('subject_role')} <> ${''} AND ${rs('subject_type')} <> ${GLOBAL.type} AND ${rs('subject_id')} = ${''} AND EXISTS (SELECT 1 FROM ${ident(S0)} WHERE ${s('subject_type')} = ${rs('subject_type')} AND ${s('subject_id')} = ${''} AND ${s('subject_role')} = ${rs('subject_role')})))`;
    const fault = any(rsql`(${e('st')} = 1)`, all(active, whenMissing(e('wc'))), all(rsql`(${e('kind')} = ${'cap'})`, active, whenApplies(e('wc')), rsql`(${e('mf')} = 1)`), all(rsql`(${e('kind')} = ${'restrict'})`, rsql`(${e('ps')} = 1)`, rsql`(${e('ix')} IS NOT NULL)`, typeOnlySet));
    return rsql`(EXISTS (SELECT 1 FROM ${ident(DR)} ${ident(E)} WHERE ${all(rsql`(${inList(e('kind'), ['restrict', 'cap'])})`, fault)}))`;
  }

  // ---- threshold (step 8) ----

  private thresholdDeny(rule: Rule, row: Row): RbacSql {
    const n = rule.n;
    const on = flag(row.col(`o${n}`));
    const absent = flag(row.col(`b${n}`));
    const min = rule.min!;
    const ladders = this.ctx.listing.ladders?.ladders ?? [];
    // The rank of the { ref } value on a ladder, NULL when it is no role of that ladder (authz_gb, `mr<n>_<ladder>`).
    const rankOn = (l: CompiledLadder): RbacSql => row.col(`mr${n}_${ladders.indexOf(l)}`);
    const xIn = (list: readonly CompiledLadder[]): RbacSql => any(...list.map((l) => rsql`(${rankOn(l)} IS NOT NULL)`));
    const gated = all(notFalseCol(row.col(`wa${n}`)), notFalseCol(row.col(`ra${n}`)));
    // The gathering reads a { ref } minRole where the rule's when is not FALSE, and refuses a value that is no ladder role.
    const fault = all(on, neg(absent), any(flag(row.col(`f${n}`)), min.kind === 'ref' ? all(notFalseCol(row.col(`wa${n}`)), neg(xIn(ladders))) : FALSE_SQL));
    const notMeets = min.kind === 'const' ? neg(this.meets(rule, min.ladder, min.rank, row)) : any(...min.ladders.map((l) => all(rsql`(${rankOn(l)} IS NOT NULL)`, neg(this.meets(rule, l, rankOn(l), row)))));
    const selected = flag(row.col(`ts${n}`));
    // A rule without its node is indeterminate: it denies where the rank is not met, and always with a { ref } minRole.
    const indeterminate = all(absent, selected, min.kind === 'ref' ? TRUE_SQL : notMeets);
    const decided = all(neg(absent), selected, notFalseCol(row.col(`w${n}`)), notFalseCol(row.col(`r${n}`)), notMeets);
    // The threshold step throws, so denies, for a minRole of another ladder than the rule's, wherever the rule applies and selects.
    const otherLadder = min.kind === 'ref' && rule.def.ladder !== undefined ? all(neg(absent), selected, gated, neg(xIn(min.ladders))) : FALSE_SQL;
    return any(fault, all(on, indeterminate), all(on, decided), all(on, otherLadder));
  }

  /** The deciding rank on `ladder` reaches `t` (`rankAtNode` at `at`, else `rowsMeeting` with the provenance types). */
  private meets(rule: Rule, ladder: CompiledLadder, t: number | RbacSql, row: Row): RbacSql {
    const madeAt = rule.at === undefined ? this.provenance(ladder) : undefined;
    return this.contributions('authz_m', 2, row, (k, src) => (k.ladder !== ladder ? FALSE_SQL : all(this.clampOK(k, src, t, row), rule.at !== undefined ? this.atOrAboveType(src, rule.at, row) : madeAt ? this.scopeTypeIn(src, madeAt) : TRUE_SQL)));
  }

  /** The scope types every grant of the permission on `ladder` names in `grantedAt`, when all of them name some. */
  private provenance(ladder: CompiledLadder): readonly string[] | undefined {
    const { listing, args } = this.ctx;
    const permission: Permission = args.permission;
    const grants = ladder.roles.flatMap((r) => listing.grants.grants(r, permission)).filter((g) => listing.ladders?.ladderOf(g.role) === ladder);
    return grants.length > 0 && grants.every((g) => g.grantedAt) ? [...new Set(grants.flatMap((g) => g.grantedAt!))] : undefined;
  }

  // ---- the term ----

  /**
   * `cond` over authz_gd, under `whenFound`, with the row-level parts of `rules` worked out below it: once per class
   * of rows (`classForm`) or once per row.
   */
  private term(rules: readonly Rule[], kind: 'route' | 'threshold', cond: (row: Row) => RbacSql): RbacSql {
    const { path, dialect } = this.ctx;
    const fence = dialect.fence;
    const nx = (type: string): string | undefined => {
      const i = this.nearTypes.indexOf(type);
      return i < 0 || path.nearestIndex(type) === undefined ? undefined : `nx${i}`;
    };
    const inPlace: Row = {
      col: (name) => {
        throw new Error(`authz-rbac rules sql: ${name} is read in authz_gb, where it is worked out`);
      },
      nearest: (type) => path.nearestIndex(type),
      index: (rule) => rule.scope.index,
    };
    const columns = (alias: string): Row => ({
      col: (name) => rsql`${ident(alias, name)}`,
      nearest: (type) => {
        const name = nx(type);
        return name === undefined ? undefined : rsql`${ident(alias, name)}`;
      },
      index: (rule) => rsql`${ident(alias, `ix${rule.n}`)}`,
    });

    const reads = new Map<number, Read>();
    for (const r of rules) for (const read of [...r.condReads.map((c) => c.read), ...(r.refRead ? [r.refRead] : [])]) reads.set(read.n, read);
    const from = [...reads.values()].map((read) => rsql`(${read.lookup.table}) ${ident(readAlias(read))}`);

    const present = (read: Read): RbacSql => readCol(read, 'present');
    const gbCols: RbacSql[] = [as(intSql(1), 'one')];
    this.nearTypes.forEach((type, i) => {
      const index = path.nearestIndex(type);
      if (index !== undefined) gbCols.push(as(index, `nx${i}`));
    });
    for (const r of rules) {
      const n = r.n;
      const absent = this.absent(r);
      const when = r.when ?? TRUE_SQL;
      gbCols.push(as(asFlag(r.scope.on), `o${n}`), as(asFlag(absent), `b${n}`), as(asThree(when), `w${n}`), as(asThree(r.resource ?? TRUE_SQL), `r${n}`));
      if (r.def.kind === 'threshold') gbCols.push(as(asThree(r.whenGate ?? TRUE_SQL), `wa${n}`), as(asThree(r.resourceGate ?? TRUE_SQL), `ra${n}`));
      gbCols.push(as(asFlag(any(...r.condReads.map(({ read, value }) => (value ? neg(all(present(read), rsql`(${readCol(read, 'json')} IS NOT NULL)`)) : neg(present(read)))))), `f${n}`));
      if (r.max.kind === 'ref') {
        const read = r.max.read;
        const ranks = r.capLadder!.roles.map((role, i) => rsql`WHEN ${present(read)} AND (${dialect.sameText(readCol(read, 'json'), rsql`${JSON.stringify(role)}`)}) THEN ${intSql(i)}`);
        gbCols.push(as(rsql`CASE ${joinSql(ranks, ' ')} END`, `m${n}`));
      }
      if (r.min?.kind === 'ref') {
        const read = r.min.read;
        (this.ctx.listing.ladders?.ladders ?? []).forEach((l, i) => {
          const ranks = l.roles.map((role, k) => rsql`WHEN ${present(read)} AND (${dialect.sameText(readCol(read, 'json'), rsql`${JSON.stringify(role)}`)}) THEN ${intSql(k)}`);
          gbCols.push(as(rsql`CASE ${joinSql(ranks, ' ')} END`, `mr${n}_${i}`));
        });
      }
      if (r.def.kind === 'restrict') {
        const selects = this.rankSelects(r, 0, inPlace);
        gbCols.push(as(r.scope.index, `ix${n}`), as(asFlag(all(r.scope.on, neg(absent), notFalse(r.bounds?.hi ?? when), selects)), `rs${n}`), as(asFlag(all(r.scope.on, absent, selects)), `ri${n}`));
        // Where the bounds disagree the check's choice is unknown here: rs<n> with rl<n> = 0 faults the row.
        if (r.bounds) gbCols.push(as(asFlag(notFalse(r.bounds.lo)), `rl${n}`));
      }
    }
    const gb = rsql`SELECT ${joinSql(gbCols, ', ')}${from.length > 0 ? rsql` FROM ${joinSql(from, ' CROSS JOIN ')}` : rsql``}${fence}`;

    const b = columns(GB);
    const gdCols: RbacSql[] = [rsql`${ident(GB)}.*`];
    for (const r of rules) {
      const n = r.n;
      if (r.def.kind === 'restrict') {
        // The steps apply restrict rules in id order (the args' order): rx<n>, the rule would drop what the earlier ones kept.
        if (r.types.length > 0 || r.bounds) gdCols.push(as(asFlag(this.contributions('authz_c', 0, b, (k, src) => all(this.keptByRestricts(k, src, b, r), this.restrictDrops(r, k, src, b)), this.db ? S1 : undefined)), `rx${n}`));
        continue;
      }
      const selects = this.rankSelects(r, 1, b);
      if (r.def.kind === 'threshold') {
        gdCols.push(as(asFlag(selects), `ts${n}`));
        continue;
      }
      const acts = this.contributions('authz_c', 1, b, (k, src) => this.capActs(r, k, src));
      gdCols.push(as(asFlag(all(flag(b.col(`o${n}`)), neg(flag(b.col(`b${n}`))), notFalseCol(b.col(`w${n}`)), selects)), `cs${n}`), as(asFlag(all(flag(b.col(`o${n}`)), flag(b.col(`b${n}`)), selects, acts)), `ci${n}`));
    }
    const verdict = cond(columns(GD));
    const holds = verdict === TRUE_SQL ? rsql`1 = 1` : verdict;
    let flagSql: RbacSql;
    if (!this.db) {
      const gd = rsql`SELECT ${joinSql(gdCols, ', ')} FROM (${gb}) ${ident(GB)}${fence}`;
      // A one-row table: the count is 1 where the verdict holds, else 0.
      flagSql = rsql`(SELECT COUNT(*) FROM (${gd}) ${ident(GD)} WHERE ${holds})`;
    } else {
      const gd = rsql`SELECT ${joinSql(gdCols, ', ')} FROM ${ident(GB)}${fence}`;
      // Materialized: every table is read from many sub-queries, which would otherwise each work it out again.
      const ctes = this.storedTables(gb, gd, b, columns(GD)).map(([name, body]) => rsql`${ident(name)} AS MATERIALIZED (${body})`);
      flagSql = rsql`(WITH ${joinSql(ctes, ', ')} SELECT COUNT(*) FROM ${ident(GD)} WHERE ${holds})`;
    }
    const out = this.classForm(rules, kind, flagSql) ?? path.whenFoundFlag(flagSql);
    if (dialect.name === 'sqlite') this.fitsSqlite(out, rules);
    return out;
  }

  /**
   * The term as a lookup of the row's class (`rbacClassForm`), or undefined for the per-row form: on SQLite (its
   * parser stack seldom takes the deeper form, and it serves stored rules in tests only), without the model's table,
   * where the class key would be empty, and for a term holding a config threshold that reads `resource.*` (every row
   * keyed by its field values: a class per value, slower than per row).
   */
  private classForm(rules: readonly Rule[], kind: 'route' | 'threshold', flagSql: RbacSql): RbacSql | undefined {
    const { path, dialect, rowTable, testOnly } = this.ctx;
    if (dialect.name !== 'postgres' || rowTable === undefined || testOnly?.rows === true) return undefined;
    // Invariant: the filtered row is a row of `rowTable`, so its class has a representative. A route term under NOT
    // would list a row whose class has none; threshold terms deny such a row (fail closed).
    if (rules.some((r) => r.def.kind === 'threshold' && [r.def.when, r.def.resource].some((c) => rbacResourceReads(c).length > 0))) return undefined;
    const constants = new Map<string, string[]>();
    for (const r of this.ctx.args.rules) if (r.scope.type !== GLOBAL.type && r.scope.id != null) constants.set(r.scope.type, [...(constants.get(r.scope.type) ?? []), r.scope.id]);
    // Every read of the args' rules, not only this term's: a superset only splits classes.
    const attributeTypes = new Set([...this.reads.values()].map((r) => r.type));
    if (this.db) for (const n of path.nodes) attributeTypes.add(n.type);
    const form = rbacClassForm(flagSql, { path, dialect, rowType: this.ctx.rowType, rowTable, assignmentTable: this.ctx.table, subjects: this.ctx.subjects, db: this.db, constants, attributeTypes, layer: (t) => this.defaults.layer(t), fields: this.ctx.fields, kind, ...(testOnly?.order ? { order: testOnly.order } : {}) });
    if (form) testOnly?.keys?.(form.keys);
    return form?.term;
  }

  /**
   * The WITH of a term with stored rules, in the order each reads the ones before: the pattern leaf count (dn),
   * assignment rows after collect (s0), the stored rules (dj, dr) and the restricts' selection (dx), the bound rules' parts (gb, gd), the rows with
   * what the stored restricts keep (s1), the caps' and thresholds' selection (dy), the rows with what the stored caps
   * do (s2), the stored rules' faults (dz, dc) and, for `thresholdDb`, their denials (dt).
   */
  private storedTables(gb: RbacSql, gd: RbacSql, b: Row, g: Row): [string, RbacSql][] {
    const { dialect } = this.ctx;
    const fence = dialect.fence;
    const kinds: RbacDbRuleKind[] = this.dbThresholds ? ['restrict', 'cap', 'threshold'] : ['restrict', 'cap'];
    const ruleTables = rbacDbRuleTables({ listing: this.ctx.listing, rowType: this.ctx.rowType, path: this.ctx.path, dialect, defaults: this.defaults, fields: this.ctx.fields, now: this.ctx.now, permission: this.ctx.args.permission, everyone: [this.ctx.args.principal, ...this.ctx.args.companions], patternLeaves: this.leavesSql() }, kinds);
    const unread: Row = {
      col: (name) => {
        throw new Error(`authz-rbac rules sql: ${name} is not read with the stored restricts' selection`);
      },
      nearest: () => undefined,
      index: () => {
        throw new Error('authz-rbac rules sql: no bound rule is read with the stored restricts');
      },
    };
    const d = (c: string) => this.dcol(D, c);
    const rankFlags = (level: 0 | 1, row: Row, a: string, z: string, kindsRead: readonly string[]) => {
      const reads = all(rsql`(${inList(d('kind'), kindsRead)})`, rsql`(${d('ps')} = 1)`, rsql`(${d('ro')} IS NOT NULL)`);
      return [as(rsql`CASE WHEN ${reads} THEN ${asFlag(this.storedHeld(D, level, row, false))} ELSE 0 END`, a), as(rsql`CASE WHEN ${reads} AND ${d('ro')} = 2 THEN ${asFlag(this.storedHeld(D, level, row, true))} ELSE 0 END`, z)];
    };
    const s0 = this.assignmentRows();
    const dx = rsql`SELECT ${ident(D)}.*, ${this.storedRank(D, 'h0', 'h1')} AS ${ident('rk')} FROM (SELECT ${ident(D)}.*, ${joinSql(rankFlags(0, unread, 'h0', 'h1', ['restrict']), ', ')} FROM ${ident(DR)} ${ident(D)}${fence}) ${ident(D)}${fence}`;
    const nearestStored = (extra: RbacSql) => rsql`(SELECT MIN(${this.dcol(E, 'ix')}) FROM ${ident(DX)} ${ident(E)} WHERE ${all(this.storedRs(E), extra, neg(this.allowsRow(E, S0)))})`;
    const s1Cols = [rsql`${ident(S0)}.*`, as(nearestStored(TRUE_SQL), 'xd'), ...this.restricts.filter((r) => r.types.length > 0 || r.bounds).map((r) => as(nearestStored(this.storedBefore(E, r.def.id)), `xe${r.n}`))];
    const s1 = rsql`SELECT ${joinSql(s1Cols, ', ')} FROM ${ident(S0)}${fence}`;
    const dy = rsql`SELECT ${ident(D)}.*, ${this.storedRank(D, 'h2', 'h3')} AS ${ident('rk1')} FROM (SELECT ${ident(D)}.*, ${joinSql(rankFlags(1, b, 'h2', 'h3', ['cap', 'threshold']), ', ')} FROM ${ident(DX)} ${ident(D)} CROSS JOIN ${ident(GB)}${fence}) ${ident(D)}${fence}`;
    const t1 = (c: string) => rsql`${ident(S1, c)}`;
    const s2Cols = [rsql`${ident(S1)}.*`, as(this.storedCapEffect('xs', 0, t1('scope_type'), t1('subject_type')), 'xs'), ...this.ladders.flatMap((_, i) => [as(this.storedCapEffect('xp', i, t1('scope_type'), t1('subject_type')), `xp${i}`), as(this.storedCapEffect('xm', i, t1('scope_type'), t1('subject_type')), `xm${i}`)])];
    const s2 = rsql`SELECT ${joinSql(s2Cols, ', ')} FROM ${ident(S1)}${fence}`;
    // A stored restrict that would drop what the earlier restricts (bound and stored, in id order) kept: it throws
    // without its node, and with an inexact when its choice is unknown here.
    const keptEarlier = (k: Kind, src: Src): RbacSql => {
      const bound = all(...this.restricts.map((r) => neg(all(flag(b.col(`rs${r.n}`)), this.boundBefore(r.def.id, D), this.restrictDrops(r, k, src, b)))));
      const stored = k.bypassRestrict ? TRUE_SQL : rsql`(NOT EXISTS (SELECT 1 FROM ${ident(DX)} ${ident(E)} WHERE ${all(this.storedRs(E), this.storedBeforeStored(E, D), this.storedDrops(E, k, src))}))`;
      return all(bound, stored);
    };
    const dz = rsql`SELECT 1 AS ${ident('f')} FROM ${ident(DX)} ${ident(D)} CROSS JOIN ${ident(GB)} WHERE ${all(
      any(this.storedRi(D), this.storedRu(D)),
      this.contributions('authz_c', 0, b, (k, src) => all(keptEarlier(k, src), this.storedDrops(D, k, src))),
    )}`;
    const dc = rsql`SELECT 1 AS ${ident('f')} FROM ${ident(DY)} ${ident(D)} CROSS JOIN ${ident(GB)} WHERE ${all(
      this.storedCi(D),
      this.contributions('authz_c', 1, b, (k, src) => this.storedCapActs(D, k, src)),
    )}`;
    const out: [string, RbacSql][] = [[DN, this.leavesTable()], [S0, s0], ...ruleTables, [DX, dx], [GB, gb], [S1, s1], [GD, gd], [DY, dy], [S2, s2], [DZ, dz], [DC, dc]];
    if (this.dbThresholds) out.push([DT, rsql`SELECT 1 AS ${ident('f')} FROM ${ident(DY)} ${ident(D)} CROSS JOIN ${ident(GD)} WHERE ${this.storedDenies(D, g)}`]);
    return out;
  }

  /** Refuses at compile time a term SQLite's parser would refuse at run time, naming the rule with the deepest condition. */
  private fitsSqlite(term: RbacSql, rules: readonly Rule[]): void {
    const depth = sqliteParserDepth(term);
    if (depth <= RBAC_SQLITE_TERM_DEPTH) return;
    let deepest: Rule | undefined;
    let most = -1;
    for (const r of rules) {
      for (const c of [r.when, r.resource, r.whenGate, r.resourceGate, r.bounds?.hi, r.bounds?.lo]) {
        const d = c === undefined ? -1 : sqliteParserDepth(c);
        if (d > most) [deepest, most] = [r, d];
      }
    }
    throw this.refuse(deepest?.def, `needs about ${depth} entries of SQLite's parser stack, more than the ${RBAC_SQLITE_TERM_DEPTH} a term may take (SQLite stops at 100); nest the rule's conditions less deeply`);
  }

  private absent(rule: Rule): RbacSql {
    return any(
      ...rule.types.map((type) => {
        const index = this.ctx.path.nearestIndex(type);
        return index === undefined ? TRUE_SQL : rsql`(${index} IS NULL)`;
      }),
    );
  }

  // ---- refusals ----

  private refuse(rule: BoundRule | undefined, why: string): AuthzConfigError {
    return new AuthzConfigError(`${this.ctx.where()}${rule ? ` rule '${rule.id}'` : ''}: ${why}`);
  }

  private stale(rule: BoundRule, why: string): AuthzConfigError {
    return this.refuse(rule, `${why}; the roles changed since the term was built, so it is refused rather than compiled against other roles`);
  }
}

/** A `resource.*` read of a condition leaf, as the list terms meet it. */
export interface RbacResourceRead {
  /** `resource.<path>` as written. */
  readonly attr: string;
  /** The leaf is `{ attr, wildcard | glob: <string> }` and nothing else, the only shape `resourceLeaf` may decide. */
  readonly pattern?: { readonly op: 'wildcard' | 'glob'; readonly literal: string };
  /** The leaf's keys besides `attr`. */
  readonly ops: readonly string[];
}

/** The `resource.*` leaves of a condition (through all/any/not); the core refuses a `resource.*` ref as a value. */
export function rbacResourceReads(c: unknown): RbacResourceRead[] {
  if (c === undefined || c === null || typeof c !== 'object') return [];
  if (Array.isArray(c)) return c.flatMap(rbacResourceReads);
  const n = c as Record<string, unknown>;
  if (Array.isArray(n.all)) return n.all.flatMap(rbacResourceReads);
  if (Array.isArray(n.any)) return n.any.flatMap(rbacResourceReads);
  if (n.not !== undefined && Object.keys(n).length === 1) return rbacResourceReads(n.not);
  if (typeof n.attr !== 'string' || n.attr.split('.')[0] !== 'resource') return [];
  const ops = Object.keys(n).filter((k) => k !== 'attr');
  const op = ops.length === 1 && (ops[0] === 'wildcard' || ops[0] === 'glob') ? ops[0] : undefined;
  const literal = op === undefined ? undefined : n[op];
  return [{ attr: n.attr, ops, ...(op !== undefined && typeof literal === 'string' ? { pattern: { op, literal } } : {}) }];
}

/** For each `resource.*` leaf of a bound condition: whether SQL can decide it (a wildcard, or a prefix glob, with a literal). */
function resourceReads(c: BoundCondition | undefined): boolean[] {
  return rbacResourceReads(c).map((r) => r.pattern !== undefined);
}
