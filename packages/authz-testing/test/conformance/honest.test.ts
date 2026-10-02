import 'mocha';
import * as fc from 'fast-check';

import { runAdapterConformance, runModelConformance } from '../../src/index.js';
import { b19Factory, denyOnlyFactory, plainAdapterSetup, rbacFactory, rbacSeeds, staticFactory, tupleAdapterSetup, tupleFactory, tupleGraphs } from './worlds.js';

describe('conformance: the kit fakes pass', () => {
  // G1 item 4: the model contract admits ReBAC. Graphs stay within maxDepth, so no vote may be indeterminate.
  runModelConformance('FakeTupleModel (ReBAC) over random tuple graphs', tupleFactory, { seeds: tupleGraphs });

  runModelConformance('FakeRbacModel over random assignments', rbacFactory, { seeds: rbacSeeds });

  runModelConformance('StaticModel with scripted residuals, deny reasons and principalTypes', staticFactory);

  // B19: without the subject, file:edit fails closed through its residuals (denyWhen TRUE, permitWhen FALSE).
  runModelConformance('StaticModel shaped like ABAC with needs_subject votes', b19Factory);

  runModelConformance('StaticModel with deny rules only (effects: deny)', denyOnlyFactory);

  runAdapterConformance('FakeAdapter with scope parents, attributes and an owner column', plainAdapterSetup);

  for (const seed of [11, 23]) {
    const [graph] = fc.sample(tupleGraphs, { numRuns: 1, seed });
    runAdapterConformance(`FakeAdapter compiling native:fake.tuple over a tuple graph (seed ${seed})`, () => tupleAdapterSetup(graph));
  }
});
