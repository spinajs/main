import 'mocha';
import { expect } from 'chai';
import { fileURLToPath } from 'node:url';

import { irScenarioEngine, readScenario, runScenario } from '../src/index.js';

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/scenarios/${name}`, import.meta.url));

describe('scenario runner', () => {
  it('reads an OpenFGA .fga.yaml test file and runs it on the IR evaluator', async () => {
    const scenario = await readScenario(fixture('docs.fga.yaml'));
    expect(scenario.asks).to.equal('relation');
    expect(scenario.tests.map((t) => [t.name, t.tuples.length, t.assertions.length])).to.deep.equal([
      ['views flow down the folders and through groups', 5, 4],
      ['a ban wins', 6, 1],
    ]);
    expect(await runScenario(scenario, irScenarioEngine)).to.deep.equal([]);
  });

  it('runs a native .authz.yaml file with column values and permission assertions', async () => {
    const scenario = await readScenario(fixture('invoices.authz.yaml'));
    expect(scenario.asks).to.equal('permission');
    expect(await runScenario(scenario, irScenarioEngine)).to.deep.equal([]);
  });

  it('reports every assertion the engine answers differently', async () => {
    const scenario = await readScenario(fixture('docs.fga.yaml'));
    const failures = await runScenario(scenario, () => ({ check: () => Promise.resolve('unknown'), listObjects: () => Promise.resolve(['doc:9']) }));
    expect(failures.map((f) => [f.test, f.assertion.kind, f.actual])).to.deep.equal([
      ['views flow down the folders and through groups', 'check', 'unknown'],
      ['views flow down the folders and through groups', 'check', 'unknown'],
      ['views flow down the folders and through groups', 'check', 'unknown'],
      ['views flow down the folders and through groups', 'list_objects', ['doc:9']],
      ['a ban wins', 'check', 'unknown'],
    ]);
  });
});
