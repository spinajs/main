import 'mocha';
import { expect } from 'chai';
import { fileURLToPath } from 'node:url';
import { irToRebacConfig } from '@spinajs/authz-ir';
import { fakeModelInitContext, readScenario, runScenario } from '@spinajs/authz-testing';
import type { Scenario, ScenarioEngine, ScenarioTuple } from '@spinajs/authz-testing';

import { MemoryTupleStore, RebacModel } from '../src/index.js';
import type { Tuple } from '../src/index.js';

const toTuple = (t: ScenarioTuple): Tuple => ({ object: t.object, relation: t.relation, subject: t.subject.relation === undefined ? { type: t.subject.type, id: t.subject.id } : { object: { type: t.subject.type, id: t.subject.id }, relation: t.subject.relation } });

/** The real ReBAC model over the scenario's model and tuples; list_objects checks every object the tuples name. */
async function rebacEngine(scenario: Scenario, tuples: readonly ScenarioTuple[]): Promise<ScenarioEngine> {
  const config = irToRebacConfig(scenario.ir);
  expect(config.problems).to.deep.equal([]);
  const model = new RebacModel({ store: new MemoryTupleStore(tuples.map(toTuple)), namespaces: config.namespaces, permissions: {} });
  await model.init(fakeModelInitContext({ permissions: [], model: model.name }));
  const truth = async (object: { type: string; id: string }, relation: string, user: { type: string; id: string }) => {
    const m = await model.check(object, relation, user);
    return m === 'member' ? 'allow' : m === 'not' ? 'deny' : 'unknown';
  };
  const objects = [...new Map(tuples.flatMap((t) => [t.object, { type: t.subject.type, id: t.subject.id }]).map((o) => [`${o.type}:${o.id}`, o])).values()];
  return {
    check: (q) => truth(q.object, q.relation, q.user),
    listObjects: async (q) => {
      const out: string[] = [];
      for (const o of objects.filter((x) => x.type === q.type)) if ((await truth(o, q.relation, q.user)) === 'allow') out.push(`${o.type}:${o.id}`);
      return out;
    },
  };
}

describe('authz-rebac: OpenFGA scenarios on the real model (Z6)', () => {
  it('passes the docs .fga.yaml file', async () => {
    const scenario = await readScenario(fileURLToPath(new URL('../../authz-testing/test/fixtures/scenarios/docs.fga.yaml', import.meta.url)));
    expect(await runScenario(scenario, rebacEngine)).to.deep.equal([]);
  });
});
