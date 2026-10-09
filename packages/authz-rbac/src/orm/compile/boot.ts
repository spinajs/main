import { AuthorizationModel, AuthzConfigError, AuthzContributor, AuthzDomains, DefaultAuthzDomains, ResourceAdapter, parseCondition, readDomainConfig } from '@spinajs/authz';
import type { AuthzContribution, ParsedCondition, PermissionRegistry, ResourceType } from '@spinajs/authz';
import { accessResourceModels } from '@spinajs/authz-orm/native';
import { Configuration } from '@spinajs/configuration';
import { Container, Inject, Injectable, Singleton } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { extractModelDescriptor } from '@spinajs/orm';
import type { ModelBase } from '@spinajs/orm';

import type { RuleDef } from '../../contracts.js';
import type { GrantIndex } from '../../model/grants.js';
import { RbacModel } from '../../model/model.js';
import type { CompiledPattern } from '../../model/patterns.js';
import { RulesExtension } from '../../model/rules/extension.js';
import { rbacDialectOf } from './dialect.js';
import { rbacResourceFields, rbacResourceReads } from './rules.js';
import type { RbacResourceRead } from './rules.js';

/** One refusal of design §6.5 rule 11. */
export interface RbacSqlBootProblem {
  readonly type: ResourceType;
  /** The grant or rule, e.g. `rbac role 'reader' grant 'file:read'`. */
  readonly source: string;
  readonly text: string;
}

/** The columns of one ORM model; no names: its table info is not loaded. */
export interface RbacSqlBootColumns {
  readonly names: readonly string[];
  /** The columns SQL reads `resource.<field>` from (`rbacResourceFields`: text, no converter). */
  readonly text: readonly string[];
}

export interface RbacSqlBootInput {
  readonly model: RbacModel;
  /** The list-scoped types whose lists run in SQL (authz-orm's adapter serves them). */
  readonly types: readonly ResourceType[];
  /** The columns of each ORM model of `type`; a type of several models has one entry per model. */
  readonly columns: (type: ResourceType) => readonly RbacSqlBootColumns[];
}

const ANY_FUNCTION = { has: () => true };

const ORM_ADAPTER_KIND = 'orm';

const SQL_PATTERNS = 'SQL decides a resource.* read only as a literal wildcard, or a literal glob of a fixed prefix and one trailing * or **, on a text column';

/**
 * A glob SQL can express: a fixed prefix and at most one trailing `*` or `**` (the SQL form of DB rules,
 * stores/rule-sql-form.ts). A `{principal.*}` template is a fixed part once substituted (patternId refuses values
 * holding `*`).
 */
export function sqlExpressibleGlob(pattern: string): boolean {
  const star = pattern.indexOf('*');
  if (star < 0) return true;
  const tail = pattern.slice(star);
  return tail === '*' || tail === '**';
}

function patternText(p: CompiledPattern): string {
  return (p.id ?? []).map((part) => (typeof part === 'string' ? part : '{}')).join('');
}

/**
 * Types a config rule acts on: those its `resourceTypes` admit that some registered permission is checked on; for a
 * threshold, the permissions it names (globs expanded as `compileRule` expands them).
 */
function ruleTypes(rule: RuleDef, types: readonly ResourceType[], registry: PermissionRegistry): ResourceType[] {
  const admitted = types.filter((t) => rule.resourceTypes === undefined || rule.resourceTypes.includes(t));
  const names = rule.kind === 'threshold' ? new Set((rule.permissions ?? []).flatMap((p) => (p.includes('*') ? registry.match(p).map((d) => d.name) : [p]))) : undefined;
  const on = new Set(registry.all().flatMap((d) => (names === undefined || names.has(d.name) ? d.types : [])));
  return admitted.filter((t) => on.has(t));
}

/** The refs the function nodes of a condition read (their args). */
function functionRefs(c: ParsedCondition): readonly string[] {
  switch (c.kind) {
    case 'all':
    case 'any':
      return c.items.flatMap(functionRefs);
    case 'not':
      return functionRefs(c.item);
    case 'fn':
      return c.facts.refs;
    default:
      return [];
  }
}

/** Why SQL cannot decide `read` as the evaluator does on rows of `type` (`RbacRulesSql.resourceLeaf`), if it cannot. */
function readProblem(read: RbacResourceRead, type: ResourceType, models: readonly RbacSqlBootColumns[]): string | undefined {
  const path = read.attr.split('.').slice(1);
  if (path.length !== 1) return `reads ${read.attr}: SQL reads only a field of one segment`;
  if (models.some((m) => !m.names.includes(path[0]))) return `reads ${read.attr}, which is not a column of type '${type}'`;
  if (models.some((m) => !m.text.includes(path[0]))) return `reads ${read.attr}, which is not a text column of type '${type}' (${SQL_PATTERNS})`;
  if (!read.pattern) {
    const op = read.ops.length === 1 && (read.ops[0] === 'glob' || read.ops[0] === 'wildcard') ? read.ops[0] : undefined;
    return op ? `matches ${read.attr} with a ${op} that is not a literal` : `reads ${read.attr} with ${read.ops.join(', ') || 'no op'} (${SQL_PATTERNS})`;
  }
  const { op, literal } = read.pattern;
  if (literal.includes('\u0000')) return `matches ${read.attr} with a ${op} holding a NUL, which SQL cannot decide`;
  if (op === 'glob' && !sqlExpressibleGlob(literal)) return `matches ${read.attr} with the glob ${JSON.stringify(literal)}, more than a fixed prefix and one trailing * or **`;
  return undefined;
}

/**
 * Design §6.5 rule 11 for one RBAC model: on the types whose lists run in SQL, a grant pattern that is a glob SQL
 * cannot express, and a config rule with a `resource.*` read in its `when` or `resource` that SQL can only treat as
 * UNKNOWN (`RbacRulesSql.resourceLeaf`): anything but a literal `wildcard`, or a literal `glob` of a fixed prefix
 * and one trailing `*`/`**`, on a one-segment field that is a text column of every model of the type. DB rules meet
 * the same limits when they are written (`rule_not_compilable`). Globs on scope attributes are not covered: SQL
 * reads them as undecided leaves, which only refuse rows.
 */
export function rbacSqlBootProblems(input: RbacSqlBootInput): RbacSqlBootProblem[] {
  const { model } = input;
  const types = new Set(input.types);
  if (types.size === 0) return [];
  const graph = model.roleGraph();
  const registry = model.permissions();
  let grants: GrantIndex;
  try {
    grants = model.grantIndex();
  } catch {
    // RbacContributor reports the bad grant (B02).
    return [];
  }
  const out = new Map<string, RbacSqlBootProblem>();
  const add = (p: RbacSqlBootProblem) => out.set(JSON.stringify([p.type, p.source, p.text]), p);

  for (const role of graph.names) {
    for (const permission of grants.permissions(role)) {
      const on = registry.get(permission)?.types ?? [];
      for (const g of grants.grants(role, permission)) {
        // Inherited grants are reported under the role that declares them.
        if (g.role !== role) continue;
        for (const p of g.patterns ?? []) {
          if (!p.glob || !types.has(p.type) || !on.includes(p.type)) continue;
          const text = patternText(p);
          if (!sqlExpressibleGlob(text)) add({ type: p.type, source: `rbac role '${role}' grant '${permission}'`, text: `the id glob ${JSON.stringify(p.pattern.id)} is more than a fixed prefix and one trailing * or **` });
        }
      }
    }
  }

  const rules = model.extensions.flatMap((e) => (e instanceof RulesExtension && e.config ? e.config.all() : []));
  for (const rule of rules) {
    const source = `rbac rule '${rule.id}'`;
    const conditions: { key: string; reads: RbacResourceRead[]; unread: string[] }[] = [];
    for (const [key, c] of [
      ['when', rule.when],
      ['resource', rule.resource],
    ] as const) {
      if (c === undefined) continue;
      let parsed: ParsedCondition;
      try {
        parsed = parseCondition(c, { functions: ANY_FUNCTION, where: `${source} ${key}` });
      } catch {
        // The rule checks of rule 9 refuse a condition that does not parse.
        continue;
      }
      const reads = rbacResourceReads(c);
      // The binding cannot fold a function reading resource.*, and the compiler refuses it, whatever the leaves read.
      const unread = [...new Set(functionRefs(parsed).filter((r) => r.split('.')[0] === 'resource'))];
      if (reads.length > 0 || unread.length > 0) conditions.push({ key, reads, unread });
    }
    if (conditions.length === 0) continue;
    for (const type of ruleTypes(rule, input.types, registry)) {
      const models = input.columns(type);
      if (models.length === 0 || models.some((m) => m.names.length === 0)) {
        for (const { key } of conditions) add({ type, source, text: `${key} reads resource.*, but the columns of type '${type}' are not loaded (boot the ORM before the authz domain)` });
        continue;
      }
      for (const { key, reads, unread } of conditions) {
        for (const ref of unread) add({ type, source, text: `${key} reads ${ref} in a function argument, which SQL cannot decide` });
        for (const read of reads) {
          const why = readProblem(read, type, models);
          if (why !== undefined) add({ type, source, text: `${key} ${why}` });
        }
      }
    }
  }
  return [...out.values()];
}

/** An ORM model's columns as its descriptor holds them after the table info loaded. */
function modelColumns(model: Class<ModelBase>): RbacSqlBootColumns {
  const descriptor = extractModelDescriptor(model as never);
  const names = (descriptor?.Columns ?? []).filter((c) => !c.Virtual && !c.Aggregate && typeof c.Name === 'string').map((c) => c.Name);
  let text: string[] = [];
  try {
    text = rbacResourceFields(model, rbacDialectOf(descriptor?.Driver as never).name).map((f) => f.column);
  } catch {
    // A driver without rule blocks: its lists refuse, so no column is a text column here.
  }
  return { names, text };
}

/** The domain's models as the host merges them over the lineage (service.ts `mergeModels`): override by name, `disable`. */
async function domainModels(domains: DefaultAuthzDomains, domain: string, container: IContainer): Promise<AuthorizationModel[]> {
  const lineage = domains.lineage(domain);
  const levels = lineage.map((n) => domains.container(n));
  const owners = container.Registry.getTypesChain(AuthorizationModel).map((e) => e.container);
  const chain = [...((await container.resolve(Array.chainOf(AuthorizationModel))) as AuthorizationModel[])];
  const levelOf = owners.map((c) => levels.indexOf(c));
  if (owners.length !== chain.length || levelOf.some((l) => l < 0)) throw new AuthzConfigError(`domain ${JSON.stringify(domain)}: rule 11 cannot match the models to the domain lineage`);
  const name = (m: AuthorizationModel): string | undefined => (typeof (m as { name?: unknown }).name === 'string' ? (m as { name: string }).name : undefined);
  let list: { model: AuthorizationModel; level: number }[] = [];
  for (let level = 0; level < levels.length; level++) {
    const configuration = (await levels[level].resolve(Configuration)) as Configuration;
    const disabled = new Set(readDomainConfig(configuration.get<unknown>(['authz']), lineage.slice(0, level + 1)).disable);
    list = list.filter((e) => {
      const n = name(e.model);
      return n === undefined || !disabled.has(n);
    });
    chain.forEach((model, i) => {
      if (levelOf[i] !== level) return;
      const n = name(model);
      const at = n === undefined ? -1 : list.findIndex((e) => e.level < level && name(e.model) === n);
      if (at >= 0) list[at] = { model, level };
      else list.push({ model, level });
    });
  }
  return list.map((e) => e.model);
}

/**
 * Boot rule §6.5.11 for every domain: the types served by authz-orm's adapter list in SQL, so the RbacModels of the
 * domain may use there only grants and config rules that SQL can express. Registered in the root container when
 * authz-rbac loads, beside authz-orm's own contributor; a domain without authz-orm types or RbacModels passes.
 * A type whose models' columns are not loaded yet has no columns: a rule reading `resource.*` there is refused.
 * Models are matched with `instanceof RbacModel`: an RbacModel of a second loaded copy of authz-rbac (CJS beside
 * ESM) is not checked here, but by that copy's own registration of this class.
 */
@Singleton()
@Injectable(AuthzContributor)
@Inject(Container)
export class RbacSqlBootCheck extends AuthzContributor {
  // The host asks every contributor again on each admin scope-attribute batch (`contributedSchemas`).
  private readonly passed = new WeakMap<IContainer, readonly unknown[]>();

  constructor(private readonly container: IContainer) {
    super();
  }

  async contribute(domain: string): Promise<AuthzContribution> {
    const domains = (await this.container.resolve(AuthzDomains)) as unknown;
    if (!(domains instanceof DefaultAuthzDomains)) throw new AuthzConfigError('rule 11 needs DefaultAuthzDomains as the AuthzDomains singleton');
    const container = domains.container(domain);
    const adapters = (await container.resolve(Array.chainOf(ResourceAdapter))) as ResourceAdapter[];
    // authz-orm does not export its adapter class from the package root; its kind names it.
    const types = [...new Set(adapters.filter((a) => a.kind === ORM_ADAPTER_KIND && a.compiles !== undefined).flatMap((a) => [...a.types]))];
    if (types.length === 0) return {};
    const models = [...new Set(await domainModels(domains, domain, container))].filter((m): m is RbacModel => m instanceof RbacModel);
    const classes = new Map(types.map((t) => [t, accessResourceModels(t)]));
    const key = [...types, ...[...classes.values()].flat(), ...models.flatMap((m) => [m, m.roleGraph(), m.permissions(), ...m.extensions.map((e) => (e instanceof RulesExtension && e.config ? e.config.all() : e))])];
    const last = this.passed.get(container);
    if (last && last.length === key.length && last.every((k, i) => k === key[i])) return {};
    const columns = (type: ResourceType) => (classes.get(type) ?? []).map(modelColumns);
    const problems = models.flatMap((model) => rbacSqlBootProblems({ model, types, columns }));
    if (problems.length === 0) {
      this.passed.set(container, key);
      return {};
    }
    const lines = problems.map((p) => `- type '${p.type}', ${p.source}: ${p.text}`);
    throw new AuthzConfigError(`domain ${JSON.stringify(domain)}: design §6.5 rule 11, lists of these types run in SQL, which cannot follow:\n${lines.join('\n')}`);
  }
}
