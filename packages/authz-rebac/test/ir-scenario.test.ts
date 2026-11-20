import 'mocha';
import { expect } from 'chai';
import { fileURLToPath } from 'node:url';
import { DefaultConditionCompiler } from '@spinajs/authz';
import { irToRebacConfig } from '@spinajs/authz-ir';
import type { CaveatContext } from '@spinajs/authz-ir';
import { fakeEvaluationContext, fakeModelInitContext, readScenario, runScenario } from '@spinajs/authz-testing';
import type { Scenario, ScenarioEngine, ScenarioTuple } from '@spinajs/authz-testing';

import { MemoryTupleStore, RebacModel } from '../src/index.js';
import type { CaveatValue, Tuple, TupleCaveat } from '../src/index.js';

const isCaveatValue = (v: unknown): v is CaveatValue => ['string', 'number', 'boolean'].includes(typeof v) || (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number'));

function toCaveat(c: NonNullable<ScenarioTuple['subject']['caveat']>): TupleCaveat {
  if (c.context === undefined) return { name: c.name };
  const context = Object.entries(c.context).map(([path, v]): [string, CaveatValue] => {
    if (!isCaveatValue(v)) throw new Error(`${c.name}: ${path} holds no caveat value`);
    return [path, v];
  });
  return { name: c.name, context: Object.fromEntries(context) };
}

const toTuple = (t: ScenarioTuple): Tuple => ({
  object: t.object,
  relation: t.relation,
  subject: t.subject.relation === undefined ? { type: t.subject.type, id: t.subject.id } : { object: { type: t.subject.type, id: t.subject.id }, relation: t.subject.relation },
  ...(t.subject.caveat ? { caveat: toCaveat(t.subject.caveat) } : {}),
});

/** The real ReBAC model over the scenario's model and tuples; list_objects checks every object the tuples name. */
async function rebacEngine(scenario: Scenario, tuples: readonly ScenarioTuple[]): Promise<ScenarioEngine> {
  const config = irToRebacConfig(scenario.ir);
  expect(config.problems).to.deep.equal([]);
  const model = new RebacModel({ store: new MemoryTupleStore(tuples.map(toTuple)), namespaces: config.namespaces, permissions: {}, caveats: config.caveats });
  await model.init(fakeModelInitContext({ permissions: [], model: model.name }));
  const truth = async (object: { type: string; id: string }, relation: string, user: { type: string; id: string }, context?: CaveatContext) => {
    const m = await model.check(object, relation, user, fakeEvaluationContext({ conditions: new DefaultConditionCompiler() }), { env: context?.env ?? {} });
    return m === 'member' ? 'allow' : m === 'not' ? 'deny' : 'unknown';
  };
  const objects = [...new Map(tuples.flatMap((t) => [t.object, { type: t.subject.type, id: t.subject.id }]).map((o) => [`${o.type}:${o.id}`, o])).values()];
  return {
    check: (q) => truth(q.object, q.relation, q.user, q.context),
    listObjects: async (q) => {
      const out: string[] = [];
      for (const o of objects.filter((x) => x.type === q.type)) if ((await truth(o, q.relation, q.user, q.context)) === 'allow') out.push(`${o.type}:${o.id}`);
      return out;
    },
  };
}

describe('authz-rebac: OpenFGA scenarios on the real model (Z6)', () => {
  it('passes the docs .fga.yaml file', async () => {
    const scenario = await readScenario(fileURLToPath(new URL('../../authz-testing/test/fixtures/scenarios/docs.fga.yaml', import.meta.url)));
    expect(await runScenario(scenario, rebacEngine)).to.deep.equal([]);
  });

  it('passes the conditions .fga.yaml file, the conditional tuples kept conditional', async () => {
    const scenario = await readScenario(fileURLToPath(new URL('../../authz-testing/test/fixtures/scenarios/conditions.fga.yaml', import.meta.url)));
    expect(await runScenario(scenario, rebacEngine)).to.deep.equal([]);
  });
});
