import type { AuthorizationModel, ModelListPlan, PermissionDef, PlanTerm, ResourceType } from '@spinajs/authz';

import type { PlanTermCompiler, RlsPlanSource, RlsSqlContext } from '../plan/index.js';
import { SESSION_BYPASS, pgIdent, rlsContext } from './sql.js';
import type { RlsTable } from './sql.js';

/** `@AccessResource(type, { rls })`: `true` refuses what the database cannot evaluate (AUTHZ020), `'partial'` widens it (AUTHZ021). */
export type RlsMode = true | 'partial';

export interface RlsResource extends RlsTable {
  readonly mode: RlsMode;
}

export interface RlsDiagnostic {
  readonly code: 'AUTHZ020' | 'AUTHZ021';
  readonly severity: 'error' | 'warning';
  readonly type: ResourceType;
  readonly permission: string;
  readonly message: string;
}

export interface RlsGenerateInput {
  /** The domain's models, in routing order. */
  readonly models: readonly AuthorizationModel[];
  /** The domain's permissions; a name it does not know is reported (AUTHZ020) and its policy matches no row. */
  readonly permissions: { get(name: string): PermissionDef | undefined };
  readonly resources: readonly RlsResource[];
  /** By model name. */
  readonly sources: ReadonlyMap<string, RlsPlanSource>;
  /** By op. */
  readonly compilers: ReadonlyMap<string, PlanTermCompiler>;
  /** The database role SYSTEM connects as; it alone may use `spina.bypass`. */
  readonly bypassRole?: string;
}

export interface RlsOutput {
  readonly up: readonly string[];
  readonly down: readonly string[];
  readonly diagnostics: readonly RlsDiagnostic[];
}

const COMMANDS = [
  ['SELECT', 'read'],
  ['UPDATE', 'update'],
  ['DELETE', 'delete'],
] as const;

const ALL: ModelListPlan = Object.freeze({ kind: 'all' });

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** What one policy could not render: an error under `rls: true`, a widening under `'partial'` (permit side TRUE, deny side dropped). */
class Findings {
  constructor(
    private readonly mode: RlsMode,
    private readonly type: ResourceType,
    private readonly permission: string,
    private readonly out: RlsDiagnostic[],
  ) {}

  get partial(): boolean {
    return this.mode === 'partial';
  }

  opaque(what: string, side: 'permit' | 'deny'): void {
    const base = { type: this.type, permission: this.permission };
    if (this.mode === true) this.out.push({ ...base, code: 'AUTHZ020', severity: 'error', message: `${this.type} ${this.permission}: ${what} cannot be evaluated by the database; set rls: 'partial' to widen it` });
    else this.out.push({ ...base, code: 'AUTHZ021', severity: 'warning', message: `${this.type} ${this.permission}: ${what} ${side === 'permit' ? 'widened to TRUE' : 'dropped from the exclusion'}` });
  }
}

async function modelPlans(input: RlsGenerateInput, def: PermissionDef, type: ResourceType, f: Findings): Promise<ModelListPlan[]> {
  const plans: ModelListPlan[] = [];
  for (const model of input.models.filter((m) => m.applies(def, type))) {
    const source = input.sources.get(model.name);
    try {
      if (source === undefined) throw new Error('no RlsPlanSource');
      plans.push(await source.plan(model, def, type));
    } catch (e) {
      f.opaque(`model '${model.name}' (${message(e)})`, 'permit');
      if (f.partial) plans.push(ALL);
    }
  }
  return plans;
}

function renderTerms(terms: readonly PlanTerm[], side: 'permit' | 'deny', ctx: RlsSqlContext, input: RlsGenerateInput, f: Findings): string[] {
  const out: string[] = [];
  for (const term of terms) {
    const compiler = input.compilers.get(term.op);
    if (compiler?.renderSql === undefined) {
      f.opaque(`term ${JSON.stringify(term.op)}`, side);
      if (side === 'permit' && f.partial) out.push('TRUE');
      continue;
    }
    out.push(`(${compiler.renderSql(term.args, ctx)})`);
  }
  return out;
}

/** The engine's combination (deny-overrides over the models' plans): any deny-all is FALSE, no permit is FALSE. */
function predicate(plans: readonly ModelListPlan[], ctx: RlsSqlContext, input: RlsGenerateInput, f: Findings): string {
  if (plans.some((p) => p.kind === 'deny-all')) return 'FALSE';
  let all = false;
  const permits: string[] = [];
  const denies: string[] = [];
  for (const plan of plans) {
    if (plan.kind === 'all') {
      all = true;
      denies.push(...renderTerms(plan.deny ?? [], 'deny', ctx, input, f));
    } else if (plan.kind === 'terms') {
      permits.push(...renderTerms(plan.permit, 'permit', ctx, input, f));
      denies.push(...renderTerms(plan.deny, 'deny', ctx, input, f));
    }
  }
  const permit = all || permits.includes('TRUE') ? 'TRUE' : permits.length === 0 ? 'FALSE' : permits.join(' OR ');
  return denies.length === 0 ? permit : `(${permit}) AND NOT (${denies.join(' OR ')})`;
}

const policyName = (type: ResourceType, suffix: string): string => pgIdent(`spina_${type.replace(/[^A-Za-z0-9_]/g, '_')}_${suffix}`);

async function tablePolicies(r: RlsResource, input: RlsGenerateInput, diagnostics: RlsDiagnostic[]): Promise<{ up: string[]; down: string[] }> {
  const ctx = rlsContext(r);
  const table = ctx.table;
  const up = [`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`];
  const names: string[] = [];
  for (const [command, action] of COMMANDS) {
    const permission = `${r.type}:${action}`;
    const f = new Findings(r.mode, r.type, permission, diagnostics);
    const def = input.permissions.get(permission);
    let using: string;
    if (def === undefined) {
      f.opaque(`permission '${permission}' is not registered`, 'permit');
      using = f.partial ? 'TRUE' : 'FALSE';
    } else {
      using = predicate(await modelPlans(input, def, r.type, f), ctx, input, f);
    }
    const name = policyName(r.type, action);
    names.push(name);
    // UPDATE would check the new row against USING too; the application stays the only gate on written values (G17).
    up.push(`CREATE POLICY ${name} ON ${table} FOR ${command} USING (${using})${command === 'UPDATE' ? ' WITH CHECK (true)' : ''}`);
  }
  // No INSERT policy would refuse every insert under FORCE; inserts are the application's to gate (G17).
  names.push(policyName(r.type, 'insert'));
  up.push(`CREATE POLICY ${policyName(r.type, 'insert')} ON ${table} FOR INSERT WITH CHECK (true)`);
  if (input.bypassRole !== undefined) {
    names.push(policyName(r.type, 'bypass'));
    up.push(`CREATE POLICY ${policyName(r.type, 'bypass')} ON ${table} FOR ALL TO ${pgIdent(input.bypassRole)} USING (${SESSION_BYPASS}) WITH CHECK (true)`);
  }
  const down = [...names.map((n) => `DROP POLICY IF EXISTS ${n} ON ${table}`), `ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`, `ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`];
  return { up, down };
}

/**
 * The row level security of every `rls` resource: per table ENABLE + FORCE, one policy per command
 * (SELECT `<type>:read`, UPDATE `<type>:update`, DELETE `<type>:delete`) rendering the permission's
 * plan for any principal, a permissive INSERT policy, and the SYSTEM bypass policy for `bypassRole`.
 * Under AUTHZ020 errors the caller must not write the migration.
 */
export async function generateRls(input: RlsGenerateInput): Promise<RlsOutput> {
  const diagnostics: RlsDiagnostic[] = [];
  const up: string[] = [];
  const down: string[] = [];
  for (const r of input.resources) {
    const t = await tablePolicies(r, input, diagnostics);
    up.push(...t.up);
    down.unshift(...t.down);
  }
  return { up, down, diagnostics };
}

/** The migration file for `output`, a class named `className` on `connection`. */
export function rlsMigrationSource(output: RlsOutput, className: string, connection: string): string {
  const list = (sql: readonly string[]) => sql.map((s) => `  ${JSON.stringify(s)},`).join('\n');
  return [
    '// Generated by `spinajs authz:rls`. Regenerate it after a policy change instead of editing it.',
    "import { Migration, OrmMigration, QueryContext } from '@spinajs/orm';",
    "import type { OrmDriver } from '@spinajs/orm';",
    '',
    `const UP = [\n${list(output.up)}\n];`,
    '',
    `const DOWN = [\n${list(output.down)}\n];`,
    '',
    'type Raw = { executeOnDb(sql: string, params: unknown[], context: QueryContext): Promise<unknown> };',
    '',
    `@Migration(${JSON.stringify(connection)})`,
    `export class ${className} extends OrmMigration {`,
    '  public async up(connection: OrmDriver): Promise<void> {',
    '    for (const sql of UP) await (connection as unknown as Raw).executeOnDb(sql, [], QueryContext.Schema);',
    '  }',
    '',
    '  public async down(connection: OrmDriver): Promise<void> {',
    '    for (const sql of DOWN) await (connection as unknown as Raw).executeOnDb(sql, [], QueryContext.Schema);',
    '  }',
    '}',
    '',
  ].join('\n');
}
