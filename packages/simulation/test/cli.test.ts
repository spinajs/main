import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensure, invariant, main, parseArgs, reportJson, SimUsageError, summaryLine, type SimSuite, type SuiteRegistry } from '../src/index.js';

function toySuite(name: string, failAfter?: number): SimSuite {
  return {
    name,
    steps: 20,
    options: { faults: [] },
    build: () => {
      let ticks = 0;
      return Promise.resolve({
        actors: [{ name: 'a', replica: 'a', tick: async () => void ticks++, restart: () => Promise.resolve() }],
        invariants: failAfter === undefined ? [] : [invariant('bounded', async () => ensure(ticks < failAfter, `ticked ${ticks} times`))],
        workload: () => Promise.resolve(),
        dispose: () => Promise.resolve(),
      });
    },
  };
}

const REGISTRY: SuiteRegistry = {
  calm: () => Promise.resolve(toySuite('calm')),
  broken: () => Promise.resolve(toySuite('broken', 5)),
};

function io() {
  const lines: string[] = [];
  const written: Record<string, string> = {};
  return { lines, written, io: { log: (l: string) => lines.push(l), writeReport: (p: string, j: string) => (written[p] = j) } };
}

describe('simulation CLI', () => {
  it('parses suites, seeds, steps and the report directory', () => {
    expect(parseArgs(['--suite', 'calm', '--seed', '7', '--seeds', '3', '--steps', '50', '--out', 'r'], ['calm'])).to.deep.equal({ suites: ['calm'], seed: 7, seeds: 3, steps: 50, out: 'r' });
    expect(parseArgs(['--all'], ['broken', 'calm']).suites).to.deep.equal(['broken', 'calm']);
    expect(parseArgs(['--suite', 'calm'], ['calm'])).to.deep.equal({ suites: ['calm'], seed: 1, seeds: 1, steps: undefined, out: undefined });
  });

  it('refuses unknown suites, unknown flags, missing values and an empty selection', () => {
    expect(() => parseArgs(['--suite', 'nope'], ['calm'])).to.throw(SimUsageError, 'unknown suite(s): nope');
    expect(() => parseArgs(['--fast'], ['calm'])).to.throw(SimUsageError, 'unknown option --fast');
    expect(() => parseArgs(['--seed'], ['calm'])).to.throw(SimUsageError, '--seed needs a value');
    expect(() => parseArgs(['--seed', 'x', '--suite', 'calm'], ['calm'])).to.throw(SimUsageError, '--seed needs a non-negative integer');
    expect(() => parseArgs([], ['calm'])).to.throw(SimUsageError, 'name a suite');
    expect(() => parseArgs(['--suite', 'calm', '--seeds', '0'], ['calm'])).to.throw(SimUsageError, '--seeds must be at least 1');
  });

  it('runs every requested seed and exits 0 when all pass', async () => {
    const out = io();
    expect(await main(['--suite', 'calm', '--seed', '4', '--seeds', '3'], REGISTRY, out.io)).to.equal(0);
    expect(out.lines.filter((l) => l.startsWith('calm seed='))).to.deep.equal([
      'calm seed=4 steps=20 faults=0 ok',
      'calm seed=5 steps=20 faults=0 ok',
      'calm seed=6 steps=20 faults=0 ok',
    ]);
    expect(out.lines.at(-1)).to.equal('simulation: all seeds passed');
  });

  it('exits 1 for a failing seed, prints the replay command and writes the report', async () => {
    const out = io();
    expect(await main(['--suite', 'broken', '--seed', '2', '--out', 'reports'], REGISTRY, out.io)).to.equal(1);
    expect(out.lines[0]).to.equal('broken seed=2 steps=10 faults=0 FAIL bounded at step 10; replay: npm run sim -- --suite broken --seed 2');
    const path = Object.keys(out.written)[0];
    expect(path).to.match(/reports[\\/]broken-2\.json$/);
    const report = JSON.parse(out.written[path]) as { failure: { error: { message: string } } };
    expect(report.failure.error.message).to.equal('ticked 10 times');
  });

  it('exits 2 with the usage on a usage error', async () => {
    const out = io();
    expect(await main(['--suite', 'nope'], REGISTRY, out.io)).to.equal(2);
    expect(out.lines.at(-1)).to.match(/^usage: npm run sim --/);
  });

  it('keeps error messages in the report JSON', () => {
    const json = reportJson({ seed: 1, steps: 0, faults: [], trace: [], failure: { invariant: 'x', error: new Error('kept'), step: 0, replay: 'r' } });
    expect((JSON.parse(json) as { failure: { error: { message: string } } }).failure.error.message).to.equal('kept');
    expect(summaryLine('s', { seed: 1, steps: 3, faults: [], trace: [] })).to.equal('s seed=1 steps=3 faults=0 ok');
  });

  it('runs bin/sim.mjs under the ts-node loader', function () {
    this.timeout(120_000);
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    const r = spawnSync(process.execPath, ['--loader', 'ts-node/esm', 'bin/sim.mjs', '--suite', 'nope'], { cwd, encoding: 'utf8' });
    expect(r.status).to.equal(2);
    expect(r.stdout).to.contain('usage: npm run sim --');
  });
});
