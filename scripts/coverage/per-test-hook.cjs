/**
 * Per-test V8 coverage, preloaded into every node process through NODE_OPTIONS by scripts/coverage/run.mjs.
 *
 * In a mocha process it snapshots block coverage at each test boundary. Taking precise coverage with
 * callCount resets the isolate's counters, so every snapshot holds only what ran since the previous one:
 * the window from `test` to `test end` is the test (its beforeEach hooks included), everything else is
 * setup. Writes two files per process:
 *
 *   NODE_V8_COVERAGE/per-test-<pid>.json   all snapshots as one V8 process coverage, merged by `c8 report`
 *                                          (the counters node itself writes at exit start after the last reset)
 *   SPINAJS_PER_TEST_COVERAGE/<pid>.json   per test: the ranges it ran or skipped, as signed ids into a range table
 */
'use strict';

const OUT = process.env.SPINAJS_PER_TEST_COVERAGE;
const V8_OUT = process.env.NODE_V8_COVERAGE;

if (OUT && V8_OUT && process.argv.some((a) => /[\\/]mocha[\\/]/.test(a))) {
  const { mkdirSync, writeFileSync } = require('fs');
  const { join, relative } = require('path');
  const { pathToFileURL } = require('url');
  const inspector = require('inspector');

  const root = pathToFileURL(process.env.SPINAJS_COVERAGE_ROOT ?? process.cwd()).href + '/';
  const tracked = (url) => url.startsWith(root + 'packages/') && !url.includes('/node_modules/');

  const session = new inspector.Session();
  session.connect();

  // The in-process inspector session answers synchronously, which the exit-time write relies on.
  const post = (method, params) => {
    let out;
    let error;
    session.post(method, params, (err, res) => {
      error = err;
      out = res;
    });
    if (error) throw error;
    return out;
  };

  post('Profiler.enable');
  post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });

  const snapshots = [];
  const ranges = new Map();
  const tests = [];
  let current;

  const rangeId = (url, r) => {
    const key = `${url}|${r.startOffset}|${r.endOffset}`;
    let id = ranges.get(key);
    if (id === undefined) ranges.set(key, (id = ranges.size + 1));
    return id;
  };

  const snapshot = () => {
    const scripts = [];
    for (const s of post('Profiler.takePreciseCoverage').result) {
      if (!tracked(s.url)) continue;
      const ran = s.functions.filter((f) => f.ranges[0].count > 0);
      if (!ran.length) continue;
      // Uncalled functions inside one that ran stay, or the outer range would count their bodies as run.
      const inRan = (f) => ran.some((r) => r.ranges[0].startOffset <= f.ranges[0].startOffset && f.ranges[0].endOffset <= r.ranges[0].endOffset);
      const functions = s.functions.filter((f) => f.ranges[0].count > 0 || inRan(f));
      scripts.push({ scriptId: s.scriptId, url: s.url, functions });
    }
    snapshots.push(...scripts);
    return scripts;
  };

  // Ranges outer to inner ( start ascending, longest first ), +id ran, -id did not. Replaying them in
  // order resolves nested blocks and functions the way v8-to-istanbul does: the innermost range wins.
  const encode = (scripts) => {
    const seq = [];
    for (const s of scripts) {
      const all = s.functions.flatMap((f) => f.ranges).sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
      for (const r of all) seq.push(r.count > 0 ? rangeId(s.url, r) : -rangeId(s.url, r));
    }
    return seq;
  };

  let ran = false;
  let written = false;
  const write = () => {
    if (written || !ran) return;
    written = true;
    snapshot();
    mkdirSync(OUT, { recursive: true });
    mkdirSync(V8_OUT, { recursive: true });
    writeFileSync(join(V8_OUT, `per-test-${process.pid}.json`), JSON.stringify({ result: snapshots }));
    const table = [...ranges.keys()].map((k) => k.split('|'));
    writeFileSync(join(OUT, `${process.pid}.json`), JSON.stringify({ cwd: process.cwd(), ranges: table, tests }));
  };

  const Runner = require(require.resolve('mocha/lib/runner', { paths: [process.cwd()] }));
  const run = Runner.prototype.run;
  // Block counting slows the code down: a test close to its timeout would fail only under coverage.
  const slowed = new WeakSet();
  const slowDown = (runnable) => {
    if (slowed.has(runnable) || !(runnable.timeout() > 0)) return;
    slowed.add(runnable);
    runnable.timeout(runnable.timeout() * 3);
  };

  Runner.prototype.run = function (...args) {
    ran = true;
    this.on('hook', slowDown);
    this.on('test', (test) => {
      slowDown(test);
      snapshot();
      current = test;
    });
    this.on('test end', (test) => {
      const scripts = snapshot();
      if (test !== current || test.isPending()) return;
      current = undefined;
      tests.push({ title: test.fullTitle(), file: test.file ? relative(process.cwd(), test.file) : '', state: test.state ?? 'unknown', seq: encode(scripts) });
    });
    this.once('end', () => {
      write();
      // What mocha --exit does, which the packages do not pass: a suite leaving a handle open would stall the whole run.
      setTimeout(() => {
        process.stderr.write(`[coverage] ${process.cwd()}: handles left open after the last test, exiting\n`);
        process.exit();
      }, 5000).unref();
    });
    return run.apply(this, args);
  };
  process.once('exit', write);
}
