import 'mocha';
import { expect } from 'chai';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { irScenarioEngine, readScenario, runScenario } from '../src/index.js';

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/scenarios/${name}`, import.meta.url));

async function expectRejection(p: Promise<unknown>, message: RegExp): Promise<void> {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(String(error)).to.match(message);
}

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

  it('maps .fga.yaml condition contexts from OpenFGA parameter names to IR parameter paths', async () => {
    const scenario = await readScenario(fixture('conditions.fga.yaml'));
    const [test] = scenario.tests;
    expect(test.tuples.find((t) => t.object.id === 'd3')?.subject).to.deep.equal({ type: 'folder', id: 'f1', caveat: { name: 'not_expired', context: { 'env.until': 20 } } });
    expect(test.tuples.find((t) => t.subject.id === 'bob')?.subject).to.deep.equal({ type: 'user', id: 'bob', caveat: { name: 'office_ip' } });
    expect(test.assertions[1]).to.deep.include({ kind: 'check', context: { env: { ip: '10.0.0.1' } } });
    expect(await runScenario(scenario, irScenarioEngine)).to.deep.equal([]);
  });

  it('refuses a context that names no condition parameter, and a condition the model does not define', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scenario-'));
    try {
      const text = await readFile(fixture('conditions.fga.yaml'), 'utf8');
      const write = async (name: string, body: string): Promise<string> => {
        await writeFile(join(dir, name), body);
        return join(dir, name);
      };
      const nope = await write('nope.fga.yaml', text.replace('context: { env_day: 10 }', 'context: { nope: 1 }'));
      await expectRejection(readScenario(nope), /check\[5\]: nope is no parameter of a condition/);
      const ghost = await write('ghost.fga.yaml', text.replace('object: doc:d2, condition: { name: office_ip }', 'object: doc:d2, condition: { name: ghost }'));
      await expectRejection(readScenario(ghost), /tuples\[2\]: condition ghost is not defined in the model/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
