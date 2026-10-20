import assert from 'node:assert/strict';

import { compileFieldGlobs, simplify } from '@spinajs/authz';
import type { Decision, ResourceFilter } from '@spinajs/authz';

import type { DecisionExpectation, FieldsProbe, ReasonExpectation, ResidualExpectation, Throws } from './types.js';

export const isThrows = (x: unknown): x is Throws => typeof x === 'object' && x !== null && typeof (x as Throws).throws === 'string';

/** The names of an error's class and its ancestor classes, nearest first. */
function errorNames(e: unknown): string[] {
  const names: string[] = [];
  if (e instanceof Error && e.name) names.push(e.name);
  for (let proto = e !== null && typeof e === 'object' ? Object.getPrototypeOf(e) : null; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    const name = (proto.constructor as { name?: string } | undefined)?.name;
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export function matchesThrows(e: unknown, t: Throws): boolean {
  if (!errorNames(e).includes(t.throws)) return false;
  const message = e instanceof Error ? e.message : String(e);
  return (t.message ?? []).every((m) => message.includes(m));
}

export function assertThrows(e: unknown, t: Throws, what: string): void {
  if (matchesThrows(e, t)) return;
  const got = e instanceof Error ? `${errorNames(e).join(' < ')}: ${e.message}` : String(e);
  assert.fail(`${what}: expected a throw of ${t.throws}${t.message ? ` mentioning ${t.message.map((m) => JSON.stringify(m)).join(', ')}` : ''}, got ${got}`);
}

/** Runs `fn` and checks its outcome against a Throws, or hands the value on. */
export async function outcome<T>(fn: () => Promise<T> | T, expect: unknown, what: string): Promise<{ readonly threw: true } | { readonly threw: false; readonly value: T }> {
  let value: T;
  try {
    value = await fn();
  } catch (e) {
    if (!isThrows(expect)) throw e;
    assertThrows(e, expect, what);
    return { threw: true };
  }
  if (isThrows(expect)) assert.fail(`${what}: expected a throw of ${expect.throws}, got ${JSON.stringify(value)}`);
  return { threw: false, value };
}

export function assertReason(actual: Decision['reason'], expected: ReasonExpectation | null, what: string): void {
  if (expected === null) {
    assert.equal(actual, undefined, `${what}: expected no reason, got ${JSON.stringify(actual)}`);
    return;
  }
  assert.ok(actual, `${what}: expected reason ${JSON.stringify(expected)}, got none`);
  const want = typeof expected === 'string' ? { code: expected } : expected;
  for (const [k, v] of Object.entries(want)) assert.deepEqual(actual[k], v, `${what}: reason.${k} of ${JSON.stringify(actual)}`);
}

/** Checks everything but `selects`, which needs world rows; returns the `selects` list when one is expected. */
export function assertResidualShape(actual: ResourceFilter | undefined, expected: ResidualExpectation, what: string): readonly string[] | undefined {
  assert.ok(actual, `${what}: no residual`);
  const op = simplify(actual).op;
  if (expected === 'TRUE') assert.equal(op, 'true', `${what}: residual ${JSON.stringify(actual)} is not TRUE`);
  else if (expected === 'FALSE') assert.equal(op, 'false', `${what}: residual ${JSON.stringify(actual)} is not FALSE`);
  else if (expected === 'conditional') assert.ok(op !== 'true' && op !== 'false', `${what}: residual ${JSON.stringify(actual)} is not conditional`);
  else if ('equals' in expected) assert.deepEqual(simplify(actual), simplify(expected.equals), `${what}: residual`);
  else return expected.selects;
  return undefined;
}

function assertProbe(globs: readonly string[] | undefined, probe: FieldsProbe, what: string): void {
  assert.ok(globs, `${what}: no field list`);
  const m = compileFieldGlobs(globs);
  for (const f of probe.allows ?? []) assert.ok(m.allows(f), `${what}: ${JSON.stringify(globs)} does not allow ${f}`);
  for (const f of probe.denies ?? []) assert.ok(!m.allows(f), `${what}: ${JSON.stringify(globs)} allows ${f}`);
}

/** Checks a decision; returns the `selects` list of the residual expectation, which the runner checks against the world rows. */
export function assertDecision(d: Decision, e: DecisionExpectation, what: string): readonly string[] | undefined {
  assert.ok(d && typeof d === 'object', `${what}: no decision`);
  if (e.allowed !== undefined) assert.equal(d.allowed, e.allowed, `${what}: allowed is ${d.allowed}, reason ${JSON.stringify(d.reason)}`);
  if (e.reason !== undefined) assertReason(d.reason, e.reason, what);
  if (e.fields?.read) assertProbe(d.fields?.read, e.fields.read, `${what}: fields.read`);
  if (e.fields?.write) assertProbe(d.fields?.write, e.fields.write, `${what}: fields.write`);
  if (e.roles !== undefined) assert.deepEqual({ ...d.roles }, { ...e.roles }, `${what}: roles`);
  if (e.validUntil !== undefined) assert.equal(d.validUntil?.getTime(), e.validUntil?.getTime(), `${what}: validUntil is ${d.validUntil?.toISOString()}`);
  if (e.trace === true || e.trace === false) assert.equal(d.trace !== undefined, e.trace, `${what}: trace presence`);
  else if (e.trace) {
    assert.ok(d.trace, `${what}: no trace`);
    const models = d.trace.votes.map((v) => v.model);
    for (const m of e.trace.votes) assert.ok(models.includes(m), `${what}: trace has no vote of ${m} (votes: ${models.join(', ')})`);
  }
  if (e.actor === null) assert.equal(d.actor, undefined, `${what}: actor`);
  else if (e.actor) assert.deepEqual({ type: d.actor?.type, id: d.actor?.id }, { type: e.actor.type, id: e.actor.id }, `${what}: actor`);
  if (e.domain !== undefined) assert.equal(d.domain, e.domain, `${what}: domain`);
  return e.residual === undefined ? undefined : assertResidualShape(d.residual, e.residual, what);
}
