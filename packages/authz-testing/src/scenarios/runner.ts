import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { IREvaluator, MemoryTupleSource, readOpenFga } from '@spinajs/authz-ir';
import type { CaveatContext, ObjectRef, PolicyIR, Truth, TupleSubjectRef } from '@spinajs/authz-ir';

/** One tuple of a scenario: `object#relation@subject`, optionally conditional. */
export interface ScenarioTuple {
  readonly object: ObjectRef;
  readonly relation: string;
  readonly subject: TupleSubjectRef;
}

/** A question and the answer the file expects; `relation` is a relation (`.fga.yaml`) or a permission (`.authz.yaml`). */
export type ScenarioAssertion =
  | { readonly kind: 'check'; readonly user: ObjectRef; readonly object: ObjectRef; readonly relation: string; readonly context?: CaveatContext; readonly expected: boolean }
  | { readonly kind: 'list_objects'; readonly user: ObjectRef; readonly type: string; readonly relation: string; readonly context?: CaveatContext; readonly expected: readonly string[] };

/** A column-derived relation's value on one row (G3): `object`'s `model.column` holds `value`. */
export interface ScenarioColumn {
  readonly object: ObjectRef;
  readonly model: string;
  readonly column: string;
  readonly value: ObjectRef;
}

export interface Scenario {
  readonly name: string;
  readonly ir: PolicyIR;
  readonly columns: readonly ScenarioColumn[];
  /** `relation` (OpenFGA tests ask for relations) or `permission` (native tests ask for permissions). */
  readonly asks: 'relation' | 'permission';
  readonly tests: ReadonlyArray<{ readonly name: string; readonly tuples: readonly ScenarioTuple[]; readonly assertions: readonly ScenarioAssertion[] }>;
}

/** What a scenario runs against: the real engine of a model, or the IR evaluator (`irScenarioEngine`). */
export interface ScenarioEngine {
  check(q: { user: ObjectRef; object: ObjectRef; relation: string; context?: CaveatContext }): Promise<Truth>;
  listObjects?(q: { user: ObjectRef; type: string; relation: string; context?: CaveatContext }): Promise<readonly string[]>;
  dispose?(): Promise<void>;
}

export interface ScenarioFailure {
  readonly test: string;
  readonly assertion: ScenarioAssertion;
  readonly actual: Truth | readonly string[];
}

type Raw = Record<string, unknown>;

// js-yaml ships no types and @types/js-yaml is not installed; only `load` is used.
const yaml = createRequire(import.meta.url)('js-yaml') as { load(text: string): unknown };

const parseRef = (text: unknown, where: string): ObjectRef => {
  const m = typeof text === 'string' ? /^([^:#\s]+):([^#\s]+)$/.exec(text) : null;
  if (m === null) throw new Error(`${where}: ${JSON.stringify(text)} is not "type:id"`);
  return { type: m[1], id: m[2] };
};

function parseSubject(text: unknown, condition: unknown, where: string): TupleSubjectRef {
  const [obj, relation] = typeof text === 'string' ? text.split('#') : [];
  const ref = parseRef(obj, where);
  const c = condition as { name?: unknown; context?: Raw } | undefined;
  return { ...ref, ...(relation === undefined ? {} : { relation }), ...(typeof c?.name === 'string' ? { caveat: { name: c.name, ...(c.context ? { context: c.context } : {}) } } : {}) };
}

function parseTuples(list: unknown, where: string): ScenarioTuple[] {
  return ((list as Raw[] | undefined) ?? []).map((t, i) => ({ object: parseRef(t.object, `${where}[${i}]`), relation: String(t.relation), subject: parseSubject(t.user, t.condition, `${where}[${i}]`) }));
}

function parseAssertions(test: Raw, where: string): ScenarioAssertion[] {
  const out: ScenarioAssertion[] = [];
  for (const [i, c] of ((test.check as Raw[] | undefined) ?? []).entries()) {
    for (const [relation, expected] of Object.entries((c.assertions as Raw | undefined) ?? {})) out.push({ kind: 'check', user: parseRef(c.user, `${where}.check[${i}]`), object: parseRef(c.object, `${where}.check[${i}]`), relation, ...(c.context ? { context: c.context } : {}), expected: expected === true });
  }
  for (const [i, l] of ((test.list_objects as Raw[] | undefined) ?? []).entries()) {
    for (const [relation, expected] of Object.entries((l.assertions as Raw | undefined) ?? {})) out.push({ kind: 'list_objects', user: parseRef(l.user, `${where}.list_objects[${i}]`), type: String(l.type), relation, ...(l.context ? { context: l.context } : {}), expected: [...(expected as string[])].sort() });
  }
  return out;
}

/**
 * Reads an OpenFGA `.fga.yaml` test file (`model` or `model_file`, `tuples`, `tests` with `check` and `list_objects`)
 * or a native `.authz.yaml` one (`ir` or `ir_file` holding a PolicyIR, assertions keyed by permission).
 */
export async function readScenario(path: string): Promise<Scenario> {
  const raw = yaml.load(await readFile(path, 'utf8')) as Raw;
  const near = (file: unknown): Promise<string> => readFile(resolve(dirname(path), String(file)), 'utf8');
  const native = raw.ir !== undefined || raw.ir_file !== undefined;
  const ir = native ? ((raw.ir ?? JSON.parse(await near(raw.ir_file))) as PolicyIR) : readOpenFga(typeof raw.model === 'string' ? raw.model : await near(raw.model_file));
  const shared = parseTuples(raw.tuples, `${path} tuples`);
  const columns = ((raw.columns as Raw[] | undefined) ?? []).map((c, i) => ({ object: parseRef(c.object, `${path} columns[${i}]`), model: String(c.model), column: String(c.column), value: parseRef(c.value, `${path} columns[${i}]`) }));
  const tests = ((raw.tests as Raw[] | undefined) ?? []).map((t, i) => ({ name: typeof t.name === 'string' ? t.name : `test ${i + 1}`, tuples: [...shared, ...parseTuples(t.tuples, `${path} tests[${i}].tuples`)], assertions: parseAssertions(t, `${path} tests[${i}]`) }));
  return { name: typeof raw.name === 'string' ? raw.name : path, ir, columns, asks: native ? 'permission' : 'relation', tests };
}

/** Runs every assertion of every test, each test on a fresh engine over its tuples; returns the mismatches. */
export async function runScenario(scenario: Scenario, engineFor: (scenario: Scenario, tuples: readonly ScenarioTuple[]) => ScenarioEngine | Promise<ScenarioEngine>): Promise<ScenarioFailure[]> {
  const failures: ScenarioFailure[] = [];
  for (const test of scenario.tests) {
    const engine = await engineFor(scenario, test.tuples);
    try {
      for (const a of test.assertions) {
        const actual = await answer(engine, a);
        if (actual !== undefined) failures.push({ test: test.name, assertion: a, actual });
      }
    } finally {
      await engine.dispose?.();
    }
  }
  return failures;
}

/** The engine's answer when it differs from the expected one; undefined when it agrees or cannot list. */
async function answer(engine: ScenarioEngine, a: ScenarioAssertion): Promise<Truth | readonly string[] | undefined> {
  if (a.kind === 'check') {
    const actual = await engine.check(a);
    return actual === (a.expected ? 'allow' : 'deny') ? undefined : actual;
  }
  if (engine.listObjects === undefined) return undefined;
  const actual = [...(await engine.listObjects(a))].sort();
  return JSON.stringify(actual) === JSON.stringify(a.expected) ? undefined : actual;
}

/** The IR evaluator as a scenario engine; a scenario that asks for relations gets a binding per asked relation. */
export function irScenarioEngine(scenario: Scenario, tuples: readonly ScenarioTuple[]): ScenarioEngine {
  const ir = structuredClone(scenario.ir);
  const source = new MemoryTupleSource(ir);
  for (const t of tuples) source.add(t.object, t.relation, t.subject);
  for (const c of scenario.columns) source.setColumn(c.model, c.column, c.object, c.value);
  const bound = (type: string, relation: string): string => {
    if (scenario.asks === 'permission') return relation;
    const name = `$relation:${type}#${relation}`;
    ir.permissions[name] ??= { type, relation, list: true, source: { origin: 'scenario' } };
    return name;
  };
  const ev = new IREvaluator(ir, source);
  return {
    check: async (q) => (await ev.check({ principal: q.user, permission: bound(q.object.type, q.relation), resource: q.object, ...(q.context ? { context: q.context } : {}) })).truth,
    listObjects: async (q) => {
      const out: string[] = [];
      for await (const o of ev.listObjects({ principal: q.user, permission: bound(q.type, q.relation), type: q.type, ...(q.context ? { context: q.context } : {}) })) out.push(`${o.type}:${o.id}`);
      return out;
    },
  };
}
