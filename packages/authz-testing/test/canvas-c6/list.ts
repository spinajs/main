import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

import type { AuthzService, Principal as EnginePrincipal } from '@spinajs/authz';

import { fixtureDsl } from '../../src/index.js';
import type { Case, FixtureExtension, HarnessSession, Step } from '../../src/index.js';
import type { Principal } from './c6/authz.js';
import { principalLabel } from './checkmany.js';
import { toPermission, toPrincipal, toResourceRef } from './facade.js';
import { loadCanvasFixtures } from './fixtures.js';
import type { CanvasCase, CanvasFixtures } from './fixtures.js';
import { LIST_MISMATCHES } from './mismatches.js';
import type { KnownListMismatch } from './mismatches.js';
import { CANVAS_SQL_TYPES, canvasSqlWorld, rowLabel } from './sql-harness.js';
import type { CanvasSqlType, SqlList } from './sql-harness.js';

/** One distinct (principal, permission, type) the cases ask: the list of every row of the type. */
export interface CanvasList {
  /** `<principal> <permission> on <type>`, ids as fixture symbols. */
  readonly key: string;
  readonly principal: Principal;
  readonly permission: string;
  readonly type: CanvasSqlType;
  /** The cases whose principal, permission and resource type these are. */
  readonly cases: readonly CanvasCase[];
}

/** The distinct lists of the cases, in first-use order. */
function canvasLists(fixtures: Pick<CanvasFixtures, 'symbolOf'>, cases: readonly CanvasCase[]): CanvasList[] {
  const byKey = new Map<string, { principal: Principal; permission: string; type: CanvasSqlType; cases: CanvasCase[] }>();
  for (const c of cases) {
    const permission = toPermission(c.capability);
    const type = toResourceRef(c.resource).type as CanvasSqlType;
    const key = `${principalLabel(c.principal, fixtures.symbolOf)} ${permission} on ${type}`;
    const hit = byKey.get(key);
    if (hit) hit.cases.push(c);
    else byKey.set(key, { principal: c.principal, permission, type, cases: [c] });
  }
  return [...byKey].map(([key, v]) => ({ key, ...v }));
}

const FIXTURES = loadCanvasFixtures();

export const CANVAS_LISTS: readonly CanvasList[] = Object.freeze(canvasLists(FIXTURES, FIXTURES.cases));

/** Set to `1` to run every list of the cases on SQLite and Postgres; without it only DEFAULT_LISTS run (B40.list). */
export const FULL_LISTS_ENV = 'K1B_FULL_LISTS';

export const FULL_LISTS = process.env[FULL_LISTS_ENV] === '1';

// One SQLite statement of the §8.5 rules takes 5-60 s on a loaded machine, so CI runs a few lists that cover the
// rules in SQL, the principal kinds and a K1b-1 pin.
export const DEFAULT_LIST_KEYS = Object.freeze([
  // The SECRET restrict row beside the org default role; a read list, so also through the middleware.
  'user MIA project:read on file',
  // A link principal under the stored policies of OPEN (public_links false), also through the middleware.
  'link OPEN_LINK anonymous project:read on project',
  'group DESIGN comment:create on project',
  // The stored branch thresholds.
  'user ED file:edit on branch',
  // Pinned by RFC K1b-1 (FALSE residual, no SQL), so default CI fails once the pin goes stale.
  'agent AGENT_SESSION task TASK for ED (projects WEB; files HOME; project.read) project:read on file',
]);

/** The lists B40.list runs by default (L4b final review I2). */
export const DEFAULT_LISTS: readonly CanvasList[] = Object.freeze(
  DEFAULT_LIST_KEYS.map((key) => {
    const hit = CANVAS_LISTS.find((l) => l.key === key);
    if (!hit) throw new Error(`canvas lists: DEFAULT_LIST_KEYS names no list ${JSON.stringify(key)}`);
    return hit;
  }),
);

export interface ListOutcome {
  readonly list: CanvasList;
  /** Why the principal cannot be built (the list then does not run). */
  readonly notListed?: string;
  /** What the list or a check threw. */
  readonly error?: string;
  readonly sql?: SqlList;
  /** Every row id of the type. */
  readonly rows?: readonly string[];
  /** The row ids `check` allows, each checked with its loaded row: the in-memory list. */
  readonly checked?: readonly string[];
  /** Row ids whose check allows only under a residual, although it had the row. */
  readonly conditional?: readonly string[];
  /** Time of the checks. */
  readonly checkMs?: number;
  /** FALSE residual only: the deny sources of the type-level request that hold on every row (`typeLevelDenies`). */
  readonly falseBecause?: readonly string[];
}

const errorText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** The deny sources of the explained type-level request whose condition is TRUE, as `<model> <code> (<policy>)`. */
async function typeLevelDenies(authz: AuthzService, principal: EnginePrincipal, permission: string, type: CanvasSqlType): Promise<string[]> {
  const d = await authz.explain({ principal, permission, resource: { type } });
  return (d.trace?.votes ?? []).flatMap((v) =>
    (v.denies ?? []).filter((x) => x.when.op === 'true').map((x) => `${v.model} ${x.reason.code}${typeof x.reason.policy === 'string' ? ` (${x.reason.policy})` : ''}`),
  );
}

/** Maps the principal as C6Facade does, lists the type through SQL and checks every row of it in the same session. */
async function runCanvasList(session: HarnessSession, list: CanvasList): Promise<ListOutcome> {
  const canvas = session.lane?.canvas;
  const sql = session.lane?.canvasSql;
  if (!canvas || !sql || !session.authz) throw new Error('runCanvasList: the session has no canvas and canvasSql lane handles');
  let principal: EnginePrincipal;
  try {
    principal = await toPrincipal(list.principal, canvas.deps);
  } catch (e) {
    return { list, notListed: errorText(e) };
  }
  const authz = session.authz as unknown as AuthzService;
  const rows = sql.rows[list.type].map((r) => r.id);
  try {
    const listed = await sql.list(principal, list.permission, list.type);
    const started = Date.now();
    const checked: string[] = [];
    const conditional: string[] = [];
    for (const id of rows) {
      const req = { principal, permission: list.permission, resource: { type: list.type, id } };
      const subject = await sql.load(req.resource);
      const d = await authz.check(subject === undefined || subject === null ? req : { ...req, subject });
      if (d.allowed && d.residual.op !== 'true') conditional.push(id);
      else if (d.allowed) checked.push(id);
    }
    const checkMs = Date.now() - started;
    const falseBecause = listed.residual.op === 'false' ? await typeLevelDenies(authz, principal, list.permission, list.type) : undefined;
    return { list, sql: listed, rows, checked, conditional, checkMs, ...(falseBecause ? { falseBecause } : {}) };
  } catch (e) {
    return { list, error: errorText(e) };
  }
}

export async function runCanvasLists(session: HarnessSession, lists: readonly CanvasList[]): Promise<ListOutcome[]> {
  const out: ListOutcome[] = [];
  for (const list of lists) out.push(await runCanvasList(session, list));
  return out;
}

/** Why a pinned list does not show the cause its pin names; undefined when it does. */
function causeProblem(o: ListOutcome, k: KnownListMismatch): string | undefined {
  if (o.sql?.residual.op !== 'false') return `the residual is ${o.sql?.residual.op ?? 'missing'}, the pin expects FALSE`;
  if (!o.falseBecause?.includes(k.falseBecause)) return `the type-level denies are ${JSON.stringify(o.falseBecause ?? [])}, the pin expects ${JSON.stringify(k.falseBecause)}`;
  return undefined;
}

const minus = (a: readonly string[], b: readonly string[]): string[] => a.filter((x) => !b.includes(x));

/** What breaks list conformance in one outcome, one line each; [] when it conforms or does not list. */
export function listProblems(o: ListOutcome): string[] {
  if (o.notListed !== undefined) return [];
  if (o.error !== undefined) return [`threw ${o.error}`];
  const { sql, rows, checked } = o as Required<Pick<ListOutcome, 'sql' | 'rows' | 'checked'>>;
  const type = o.list.type;
  const labels = (ids: readonly string[]): string => [...ids].map((id) => rowLabel(FIXTURES, type, id)).sort().join(', ');
  const out: string[] = [];
  if (sql.residual.op === 'false') {
    if (sql.statements.length !== 0) out.push(`a FALSE residual ran ${sql.statements.length} statements`);
  } else if (sql.statements.length !== 1) {
    out.push(`ran ${sql.statements.length} statements: ${sql.statements.join(' | ')}`);
  } else {
    if (!/^(WITH|SELECT)\b/i.test(sql.statements[0].trimStart())) out.push(`the statement is no SELECT: ${sql.statements[0].slice(0, 80)}`);
    if (sql.returned !== sql.ids.length) out.push(`the statement returned ${sql.returned ?? 'no rows array'}, the list holds ${sql.ids.length}`);
  }
  if (o.conditional && o.conditional.length > 0) out.push(`check stays conditional with the row loaded: ${labels(o.conditional)}`);
  if (new Set(sql.ids).size !== sql.ids.length) out.push(`SQL lists a row twice: ${labels(sql.ids)}`);
  const sqlOnly = minus(sql.ids, checked);
  const checkOnly = minus(checked, sql.ids);
  if (sqlOnly.length > 0) out.push(`SQL lists rows check refuses: ${labels(sqlOnly)}`);
  if (checkOnly.length > 0) out.push(`SQL leaves out rows check allows: ${labels(checkOnly)}`);
  if (sql.viaMiddleware !== undefined && !isDeepStrictEqual([...sql.viaMiddleware].sort(), [...sql.ids].sort())) out.push(`the middleware lists ${labels(sql.viaMiddleware)}, the compiled residual ${labels(sql.ids)}`);
  for (const c of o.list.cases) {
    const own = toResourceRef(c.resource).id as string;
    if (!rows.includes(own)) continue;
    const listed = sql.ids.includes(own);
    if (listed !== c.expected.allowed) out.push(`case "${c.name}": ${labels([own])} is ${listed ? '' : 'not '}listed, the case expects ${c.expected.allowed ? 'allow' : 'deny'}`);
  }
  return out;
}

export interface ListVerdict {
  /** Lists that conform. */
  readonly listed: number;
  /** `<key>: <reason>` of the lists whose principal cannot be built. */
  readonly notListed: readonly string[];
  /** `<key> (<rfc>)` of the known mismatches that still fail as pinned. */
  readonly known: readonly string[];
  /** Lines that fail the suite. */
  readonly unexpected: readonly string[];
  /** Counts for the log: per type, statements, rows, FALSE residuals. */
  readonly summary: string;
}

/** Holds each outcome to its pin: a pinned list must show exactly its problems, every other list none. */
export function judgeLists(outcomes: readonly ListOutcome[], known: Readonly<Record<string, KnownListMismatch>>): ListVerdict {
  const unexpected: string[] = [];
  const notListed: string[] = [];
  const pinned: string[] = [];
  const perType = new Map<string, number>(CANVAS_SQL_TYPES.map((t) => [t, 0]));
  let listed = 0;
  let statements = 0;
  let rowsListed = 0;
  let falseResiduals = 0;
  for (const o of outcomes) {
    const k = Object.hasOwn(known, o.list.key) ? known[o.list.key] : undefined;
    if (o.notListed !== undefined) {
      notListed.push(`${o.list.key}: ${o.notListed}`);
      if (k) unexpected.push(`${o.list.key}: known mismatch ${k.rfc} does not list (${o.notListed})`);
      continue;
    }
    if (o.sql) {
      statements += o.sql.statements.length;
      rowsListed += o.sql.ids.length;
      if (o.sql.residual.op === 'false') falseResiduals++;
      perType.set(o.list.type, perType.get(o.list.type)! + 1);
    }
    const problems = listProblems(o);
    if (problems.length === 0) {
      if (k) unexpected.push(`${o.list.key}: known mismatch ${k.rfc} now conforms; remove it from LIST_MISMATCHES`);
      else listed++;
    } else if (k && isDeepStrictEqual(problems, [...k.problems])) {
      const cause = causeProblem(o, k);
      if (cause) unexpected.push(`${o.list.key}: known mismatch ${k.rfc} shows its problems, but ${cause}`);
      else pinned.push(`${o.list.key} (${k.rfc})`);
    } else {
      if (k) unexpected.push(`${o.list.key}: known mismatch ${k.rfc} is pinned to ${JSON.stringify(k.problems)}`);
      for (const p of problems) unexpected.push(`${o.list.key}: ${p}`);
    }
  }
  const keys = new Set(CANVAS_LISTS.map((l) => l.key));
  for (const [key, k] of Object.entries(known)) if (!keys.has(key)) unexpected.push(`${key}: known mismatch ${k.rfc} names no list of the cases`);
  const types = [...perType].map(([t, n]) => `${t} ${n}`).join(', ');
  const summary = `${listed}/${outcomes.length} lists conform (${types}); ${statements} statements, ${rowsListed} rows listed, ${falseResiduals} FALSE residuals without SQL; ${notListed.length} do not list; ${pinned.length} known mismatches`;
  return { listed, notListed, known: pinned, unexpected, summary };
}

/** The `n` slowest lists: SQL time (filter, compile, statement) and check time. */
export function slowest(outcomes: readonly ListOutcome[], n: number): string[] {
  const total = (o: ListOutcome): number => (o.sql?.ms ?? 0) + (o.checkMs ?? 0);
  return [...outcomes]
    .sort((a, b) => total(b) - total(a))
    .slice(0, n)
    .map((o) => `${o.list.key}: SQL ${o.sql?.ms ?? '-'} ms, ${o.rows?.length ?? 0} checks ${o.checkMs ?? '-'} ms`);
}

const listStep = (list: CanvasList): Step => ({
  note: `canvas list ${list.key}`,
  async do(ctx) {
    const verdict = judgeLists([await runCanvasList(ctx.session, list)], LIST_MISMATCHES.sqlite);
    assert.deepStrictEqual({ notListed: verdict.notListed, unexpected: verdict.unexpected }, { notListed: [], unexpected: [] });
  },
});

/** B40.list: DEFAULT_LISTS on SQLite with the full §8.5 config, each list in a fresh system (L4b final review I2). */
export const B40List: FixtureExtension = fixtureDsl.extension('B40', [
  {
    name: 'list',
    facets: ['canvas', 'list', 'sql'],
    lanes: ['K1'],
    note: `K1 task 9: a few canvas lists through authz-orm SQL on SQLite with the state written through AuthzAdmin (the SECRET restrict row, the stored org policies, the stored branch thresholds; users, a group and a link; an agent list held to its RFC K1b-1 pin): one statement, exactly the rows check allows, each case resource iff the case allows. Every list of the cases runs in test/canvas-c6/list.test.ts with ${FULL_LISTS_ENV}=1, on SQLite and on Postgres.`,
    cases: DEFAULT_LISTS.map((l): Case => ({ name: l.key, world: canvasSqlWorld('sqlite'), steps: [listStep(l)] })),
  },
]);
