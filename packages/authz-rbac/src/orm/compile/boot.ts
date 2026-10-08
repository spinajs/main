import { AuthorizationModel, AuthzConfigError, AuthzContributor, AuthzDomains, ResourceAdapter, parseCondition } from '@spinajs/authz';
import type { AuthzContribution, ParsedCondition, PermissionRegistry, ResourceType } from '@spinajs/authz';
import { accessResourceModels } from '@spinajs/authz-orm/native';
import { Container, Inject, Injectable, Singleton } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { extractModelDescriptor } from '@spinajs/orm';

import type { RuleDef } from '../../contracts.js';
import type { GrantIndex } from '../../model/grants.js';
import { RbacModel } from '../../model/model.js';
import type { CompiledPattern } from '../../model/patterns.js';
import { RulesExtension } from '../../model/rules/extension.js';

/** One refusal of design §6.5 rule 11. */
export interface RbacSqlBootProblem {
  readonly type: ResourceType;
  /** The grant or rule, e.g. `rbac role 'reader' grant 'file:read'`. */
  readonly source: string;
  readonly text: string;
}

export interface RbacSqlBootInput {
  readonly model: RbacModel;
  /** The list-scoped types whose lists run in SQL (authz-orm's adapter serves them). */
  readonly types: readonly ResourceType[];
  /** Column names of each ORM model of `type`; a type of several models has one list per model. */
  readonly columns: (type: ResourceType) => readonly (readonly string[])[];
}

const ANY_FUNCTION = { has: () => true };

const ORM_ADAPTER_KIND = 'orm';

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

function resourceGlobs(c: ParsedCondition): Extract<ParsedCondition, { kind: 'cmp' }>[] {
  switch (c.kind) {
    case 'all':
    case 'any':
      return c.items.flatMap(resourceGlobs);
    case 'not':
      return resourceGlobs(c.item);
    case 'cmp':
      return c.attr.root === 'resource' && c.op === 'glob' ? [c] : [];
    default:
      return [];
  }
}

/**
 * Design §6.5 rule 11 for one RBAC model: on the types whose lists run in SQL, a grant pattern that is a glob SQL
 * cannot express, and a config rule whose `when` or `resource` reads a `resource.*` field that is no column of the
 * type, or matches it with such a glob (or with a glob that is not a literal). DB rules meet the same limits when
 * they are written (`rule_not_compilable`). Globs on scope attributes are not covered: SQL reads them as
 * undecided leaves, which only refuse rows.
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
    const parsed: [string, ParsedCondition][] = [];
    for (const [key, c] of [
      ['when', rule.when],
      ['resource', rule.resource],
    ] as const) {
      if (c === undefined) continue;
      try {
        parsed.push([key, parseCondition(c, { functions: ANY_FUNCTION, where: `${source} ${key}` })]);
      } catch {
        // The rule checks of rule 9 refuse a condition that does not parse.
      }
    }
    for (const type of ruleTypes(rule, input.types, registry)) {
      const models = input.columns(type);
      for (const [key, c] of parsed) {
        const fields = [...new Set(c.facts.refs.filter((r) => r.split('.')[0] === 'resource').map((r) => r.split('.')[1] ?? ''))];
        for (const field of fields) {
          if (models.length === 0 || models.some((columns) => !columns.includes(field))) add({ type, source, text: `${key} reads resource.${field}, which is not a column of type '${type}'` });
        }
        for (const leaf of resourceGlobs(c)) {
          const literal = leaf.operand.kind === 'literal' && typeof leaf.operand.value === 'string' ? leaf.operand.value : undefined;
          if (literal === undefined) add({ type, source, text: `${key} matches ${leaf.attr.text} with a glob that is not a literal` });
          else if (!sqlExpressibleGlob(literal)) add({ type, source, text: `${key} matches ${leaf.attr.text} with the glob ${JSON.stringify(literal)}, more than a fixed prefix and one trailing * or **` });
        }
      }
    }
  }
  return [...out.values()];
}

/** Column names of an ORM model as its descriptor holds them after the table info loaded. */
function columnNames(model: unknown): string[] {
  const descriptor = extractModelDescriptor(model as never);
  return (descriptor?.Columns ?? []).filter((c) => !c.Virtual && !c.Aggregate && typeof c.Name === 'string').map((c) => c.Name);
}

/**
 * Boot rule §6.5.11 for every domain: the types served by authz-orm's adapter list in SQL, so the RbacModels of the
 * domain may use there only grants and config rules that SQL can express. Registered in the root container when
 * authz-rbac loads, beside authz-orm's own contributor; a domain without authz-orm types or RbacModels passes.
 * A type whose models' columns are not loaded yet has no columns: a rule reading `resource.*` there is refused.
 */
@Singleton()
@Injectable(AuthzContributor)
@Inject(Container)
export class RbacSqlBootCheck extends AuthzContributor {
  constructor(private readonly container: IContainer) {
    super();
  }

  async contribute(domain: string): Promise<AuthzContribution> {
    if (!this.container.isResolved(AuthzDomains)) return {};
    const domains = this.container.get(AuthzDomains);
    if (!domains) return {};
    const container = domains.container(domain);
    const adapters = (await container.resolve(Array.chainOf(ResourceAdapter))) as ResourceAdapter[];
    // authz-orm does not export its adapter class from the package root; its kind names it.
    const types = [...new Set(adapters.filter((a) => a.kind === ORM_ADAPTER_KIND && a.compiles !== undefined).flatMap((a) => [...a.types]))];
    if (types.length === 0) return {};
    const models = [...new Set((await container.resolve(Array.chainOf(AuthorizationModel))) as AuthorizationModel[])].filter((m): m is RbacModel => m instanceof RbacModel);
    const columns = (type: ResourceType) => accessResourceModels(type).map(columnNames);
    const problems = models.flatMap((model) => rbacSqlBootProblems({ model, types, columns }));
    if (problems.length === 0) return {};
    const lines = problems.map((p) => `- type '${p.type}', ${p.source}: ${p.text}`);
    throw new AuthzConfigError(`domain ${JSON.stringify(domain)}: design §6.5 rule 11, lists of these types run in SQL, which cannot follow:\n${lines.join('\n')}`);
  }
}
