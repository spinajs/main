import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

import { fixtureDsl } from '../../src/index.js';
import type { BehaviourId, Case, Facet, FixtureExtension, Step, World } from '../../src/index.js';
import type { Authz, Decision } from './c6/authz.js';
import { loadCanvasFixtures } from './fixtures.js';
import type { AuthzCase, CanvasCase } from './fixtures.js';
import { canvasWorld } from './harness.js';
import { KNOWN_MISMATCHES } from './mismatches.js';

export interface CaseOutcome {
  readonly name: string;
  readonly expected: Decision;
  /** Absent when `can` threw. */
  readonly got?: Decision;
  readonly error?: string;
}

export interface ConformanceResult {
  readonly cases: number;
  readonly outcomes: readonly CaseOutcome[];
  /** One line per mismatch: `<name>: expected <json>, got <json>` (canvas runAuthzConformance format). */
  readonly failures: readonly string[];
}

export interface KnownMismatch {
  readonly rfc: string;
  /** The C6 decision the facade returns today. */
  readonly got: Decision;
}

const errorText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** Port of canvas runAuthzConformance over a ready facade; a throw is a failure line, not a crash. */
export async function canvasConformance(facade: Authz, cases: readonly AuthzCase[]): Promise<ConformanceResult> {
  const outcomes: CaseOutcome[] = [];
  const failures: string[] = [];
  for (const c of cases) {
    let got: Decision;
    try {
      got = await facade.can(c.principal, c.capability, c.resource);
    } catch (e) {
      const error = errorText(e);
      outcomes.push({ name: c.name, expected: c.expected, error });
      failures.push(`${c.name}: expected ${JSON.stringify(c.expected)}, threw ${error}`);
      continue;
    }
    outcomes.push({ name: c.name, expected: c.expected, got });
    if (!isDeepStrictEqual(got, c.expected)) failures.push(`${c.name}: expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(got)}`);
  }
  return { cases: cases.length, outcomes, failures };
}

export interface ConformanceVerdict {
  readonly conform: number;
  readonly cases: number;
  /** Lines that fail the suite: new mismatches, throws, and known mismatches whose answer moved. */
  readonly unexpected: readonly string[];
  /** `<name> (<rfc>)` of the known mismatches that still answer as pinned. */
  readonly known: readonly string[];
}

/** Holds a run against the pinned mismatches: each must answer exactly its `got`; everything else must conform. */
export function judgeConformance(result: ConformanceResult, known: Readonly<Record<string, KnownMismatch>>): ConformanceVerdict {
  const unexpected: string[] = [];
  const pinned: string[] = [];
  let conform = 0;
  for (const o of result.outcomes) {
    const k = Object.hasOwn(known, o.name) ? known[o.name] : undefined;
    if (o.error !== undefined) {
      unexpected.push(`${o.name}: expected ${JSON.stringify(k ? k.got : o.expected)}, threw ${o.error}`);
      continue;
    }
    if (isDeepStrictEqual(o.got, o.expected)) {
      conform++;
      if (k) unexpected.push(`${o.name}: known mismatch ${k.rfc} now conforms; remove it from KNOWN_MISMATCHES`);
      continue;
    }
    if (k && isDeepStrictEqual(o.got, k.got)) pinned.push(`${o.name} (${k.rfc})`);
    else if (k) unexpected.push(`${o.name}: known mismatch ${k.rfc} pinned ${JSON.stringify(k.got)}, got ${JSON.stringify(o.got)} (expected ${JSON.stringify(o.expected)})`);
    else unexpected.push(`${o.name}: expected ${JSON.stringify(o.expected)}, got ${JSON.stringify(o.got)}`);
  }
  const names = new Set(result.outcomes.map((o) => o.name));
  for (const name of Object.keys(known)) if (!names.has(name)) unexpected.push(`${name}: known mismatch ${known[name].rfc} names no case`);
  return { conform, cases: result.cases, unexpected, known: pinned };
}

const caseStep = (c: CanvasCase, known: Readonly<Record<string, KnownMismatch>>): Step => ({
  note: `canvas case ${c.index}`,
  async do(ctx) {
    const canvas = ctx.session.lane?.canvas;
    assert.ok(canvas, 'the session has no canvas lane handle');
    const want = Object.hasOwn(known, c.name) ? known[c.name].got : c.expected;
    const got = await canvas.facade.can(c.principal, c.capability, c.resource);
    assert.deepStrictEqual(got, want, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  },
});

/** One kit case per canvas case, titled with the canvas name, run in a fresh system each. */
export function canvasKitCases(cases: readonly CanvasCase[], world: World, known: Readonly<Record<string, KnownMismatch>>): Case[] {
  return cases.map((c) => ({ name: c.name, world, steps: [caseStep(c, known)] }));
}

const NOTE = 'K1: canvas C6 conformance cases through C6Facade over the design §8.5 config, the state.json scope resolver and the state written through AuthzAdmin';

/** A fixture extension whose one part holds a kit case per canvas case; it replaces the kit's empty part of that name. */
export function canvasExtension(id: BehaviourId, part: string, cases: readonly CanvasCase[], world: World, note: string, known: Readonly<Record<string, KnownMismatch>>, facets: readonly Facet[] = ['canvas']): FixtureExtension {
  return fixtureDsl.extension(id, [{ name: part, facets: [...facets], lanes: ['K1'], note: `${NOTE}${note}`, cases: canvasKitCases(cases, world, known) }]);
}

function pinnedBy(cases: readonly CanvasCase[], decision: string): CanvasCase[] {
  const hits = cases.filter((c) => c.decision === decision);
  if (hits.length !== 1) throw new Error(`canvas cases: expected one case pinned by ${decision}, found ${hits.length}`);
  return hits;
}

const CASES = loadCanvasFixtures().cases;

export const B40Memory = canvasExtension('B40', 'memory', CASES, canvasWorld('memory'), ', in memory: all 64 cases.', KNOWN_MISMATCHES.memory);
export const B42Canvas = canvasExtension('B42', 'canvas', pinnedBy(CASES, 'H21'), canvasWorld('memory'), ': the pinned H21 case.', KNOWN_MISMATCHES.memory);
export const B46Canvas = canvasExtension('B46', 'canvas', pinnedBy(CASES, 'H27'), canvasWorld('memory'), ': the pinned H27 case.', KNOWN_MISMATCHES.memory);
// The stub's facets: the data goes through AuthzAdmin into the authz tables (admin, store) on SQLite (sql).
export const B40Sqlite = canvasExtension('B40', 'sqlite', CASES, canvasWorld('sqlite'), ', on SQLite through registerRbac with the §8.5 DB stores: all 64 cases.', KNOWN_MISMATCHES.sqlite, ['canvas', 'admin', 'store', 'sql']);
