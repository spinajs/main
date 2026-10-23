/**
 * Mocha --require hook: where a suite spends its time. Writes to PROFILE_OUT the run's wall time, the
 * time in tests, in hooks and outside both ( module loading, suite setup ), and the slowest tests and
 * hooks. A hook that runs per test ( beforeEach ) is summed over its runs.
 *
 *   PROFILE_OUT=profile.json npx ts-mocha -p tsconfig.json --require ../../scripts/coverage/profile-tests.cjs
 */
'use strict';

const { writeFileSync } = require('fs');
const Runner = require(require.resolve('mocha/lib/runner', { paths: [process.cwd()] }));

const started = Date.now();
const tests = [];
const hooks = new Map();
let runStarted;

const run = Runner.prototype.run;
Runner.prototype.run = function (...args) {
  runStarted = Date.now();
  this.on('test end', (test) => tests.push({ title: test.fullTitle(), file: test.file ?? '', ms: test.duration ?? 0 }));
  this.on('hook end', (hook) => {
    const key = `${hook.parent?.fullTitle() ?? ''} :: ${hook.title}`;
    const h = hooks.get(key) ?? { hook: key, runs: 0, ms: 0 };
    h.runs++;
    h.ms += hook.duration ?? 0;
    hooks.set(key, h);
  });
  this.once('end', () => {
    const inTests = tests.reduce((n, t) => n + t.ms, 0);
    const inHooks = [...hooks.values()].reduce((n, h) => n + h.ms, 0);
    const wall = Date.now() - started;
    writeFileSync(
      process.env.PROFILE_OUT,
      JSON.stringify(
        {
          wallMs: wall,
          beforeRunMs: runStarted - started,
          testsMs: inTests,
          hooksMs: inHooks,
          otherMs: Date.now() - runStarted - inTests - inHooks,
          tests: tests.length,
          slowestTests: [...tests].sort((a, b) => b.ms - a.ms).slice(0, 40),
          slowestHooks: [...hooks.values()].sort((a, b) => b.ms - a.ms).slice(0, 25),
          byFile: Object.entries(tests.reduce((acc, t) => ((acc[t.file] = (acc[t.file] ?? 0) + t.ms), acc), {}))
            .sort((a, b) => b[1] - a[1])
            .slice(0, 25),
        },
        null,
        1,
      ),
    );
  });
  return run.apply(this, args);
};
