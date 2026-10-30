#!/usr/bin/env node
// Cold-start benchmark: time from spawning the app process to HttpServer listening, manifest mode `off` vs `require`.
// Usage: node scripts/bench/cold-start.mjs [--controllers 200] [--routes 5] [--runs 5] [--out bench.json] [--keep]
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MODES = ['off', 'require'];
const LISTEN_TIMEOUT_MS = 120_000;

function fail(message) {
  throw new Error(message);
}

function positiveInt(name, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) fail(`${name} needs a positive integer`);
  return n;
}

function parseArgs(argv) {
  const options = { controllers: 200, routes: 5, runs: 5, out: 'bench.json', keep: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--keep') options.keep = true;
    else if (arg === '--controllers' || arg === '--routes' || arg === '--runs') options[arg.slice(2)] = positiveInt(arg, argv[++i]);
    else if (arg === '--out') options.out = argv[++i] ?? fail('--out needs a path');
    else fail(`unknown argument ${arg}`);
  }
  return options;
}

const children = new Set();

function killChildren() {
  for (const child of children) child.kill('SIGKILL');
  children.clear();
}

function run(script, args, cwd) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) fail(`${script} ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function controllerSource(index, routes) {
  const methods = Array.from(
    { length: routes },
    (_, j) => `
  @Get('r${j}')
  public async r${j}(): Promise<Ok<{ controller: number; route: number }>> {
    return new Ok({ controller: ${index}, route: ${j} });
  }`,
  ).join('\n');
  return `import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('c${index}')
export class C${index} extends BaseController {${methods}
}
`;
}

// A real app boots through its own Configuration subclass and the bootstrappers, like the http e2e suites.
const BOOT_SOURCE = `import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DI, Bootstrapper } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { fsService } from '@spinajs/fs';
import { Intl } from '@spinajs/intl';
import { Controllers, HttpServer } from '@spinajs/http';

class BenchConfiguration extends FrameworkConfiguration {
  async resolve() {
    await super.resolve();
    const provider = (name) => ({ service: 'fsNative', name, basePath: tmpdir() });
    this.Config = {
      system: { dirs: { controllers: [fileURLToPath(new URL('./lib/controllers', import.meta.url))] } },
      fs: {
        defaultProvider: 'fs-temp',
        providers: [provider('fs-temp'), provider('__file_upload_default_provider__'), provider('__fs_http_templates__'), provider('__fs_controller_cache__'), provider('__fs_http_response_templates__')],
      },
      intl: { locales: ['en'], defaultLocale: 'en' },
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '\${message}' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
      http: { port: 0 },
    };
  }
}

DI.register(BenchConfiguration).as(Configuration, { replace: true });
for (const b of await DI.resolve(Array.ofType(Bootstrapper))) await b.bootstrap();
await DI.resolve(Configuration);
await DI.resolve(fsService);
await DI.resolve(Intl);
await DI.resolve(Controllers);
const server = await DI.resolve(HttpServer);
await server.start();
console.log('LISTENING ' + JSON.stringify({ port: server.Server.address().port, inProcessMs: Math.round(performance.now()) }));
`;

function generateApp(dir, { controllers, routes }) {
  mkdirSync(join(dir, 'src/controllers'), { recursive: true });
  const dependencies = Object.fromEntries(['configuration', 'di', 'fs', 'http', 'intl'].map((name) => [`@spinajs/${name}`, '*']));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'cold-start-app', version: '0.0.0', type: 'module', private: true, main: 'lib/index.js', dependencies }, null, 2));
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2021',
        module: 'node16',
        moduleResolution: 'node16',
        rootDir: './src',
        outDir: './lib',
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        strict: true,
        strictPropertyInitialization: false,
        skipLibCheck: true,
        esModuleInterop: true,
        declaration: true,
        types: ['node'],
      },
      include: ['src/**/*'],
    }),
  );
  const names = Array.from({ length: controllers }, (_, i) => `C${i}`);
  for (const [i, name] of names.entries()) writeFileSync(join(dir, `src/controllers/${name}.ts`), controllerSource(i, routes));
  writeFileSync(join(dir, 'src/index.ts'), names.map((name) => `export * from './controllers/${name}.js';`).join('\n') + '\n');
  writeFileSync(join(dir, 'boot.mjs'), BOOT_SOURCE);
}

function buildApp(dir) {
  const started = Date.now();
  run(join(repoRoot, 'node_modules/typescript-7/lib/tsc.js'), ['-p', 'tsconfig.json'], dir);
  run(join(repoRoot, 'packages/cli/lib/cli.js'), ['build', '--tsconfig', 'tsconfig.json', '--out', 'app.manifest.json'], dir);
  if (!existsSync(join(dir, 'app.manifest.json'))) fail('spinajs build did not write app.manifest.json');
  return Date.now() - started;
}

async function getOk(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) fail(`${url} answered ${res.status}`);
}

function waitForListening(child, captured) {
  return new Promise((resolveLine, reject) => {
    const timer = setTimeout(() => reject(new Error(`no LISTENING line within ${LISTEN_TIMEOUT_MS} ms\n${captured.text}`)), LISTEN_TIMEOUT_MS);
    child.once('exit', (code) => reject(new Error(`app exited with ${code} before listening\n${captured.text}`)));
    child.stdout.on('data', (chunk) => {
      captured.text += chunk;
      const match = /LISTENING (\{.*\})/.exec(captured.text);
      if (match) {
        clearTimeout(timer);
        resolveLine(JSON.parse(match[1]));
      }
    });
  });
}

async function bootOnce(dir, mode, { controllers, routes }) {
  const env = { ...process.env, SPINAJS_MANIFEST_MODE: mode };
  if (mode === 'off') delete env.SPINAJS_MANIFEST;
  else env.SPINAJS_MANIFEST = join(dir, 'app.manifest.json');

  const started = performance.now();
  const child = spawn(process.execPath, ['boot.mjs'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  const closed = new Promise((done) => child.once('close', done));
  const captured = { text: '' };
  child.stderr.on('data', (chunk) => (captured.text += chunk));

  try {
    const line = await waitForListening(child, captured);
    const elapsed = performance.now() - started;
    const base = `http://127.0.0.1:${line.port}`;
    // The last route proves the whole set loaded, not just the first controller.
    await getOk(`${base}/c0/r0`);
    await getOk(`${base}/c${controllers - 1}/r${routes - 1}`);
    return { ms: elapsed, inProcessMs: line.inProcessMs };
  } finally {
    child.kill('SIGKILL');
    children.delete(child);
    await closed;
  }
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round = (n) => Math.round(n * 10) / 10;

async function measure(dir, options) {
  const samples = Object.fromEntries(MODES.map((mode) => [mode, []]));
  // One discarded boot per mode warms the OS file cache; measured runs alternate modes so drift hits both.
  for (const mode of MODES) await bootOnce(dir, mode, options);
  for (let i = 0; i < options.runs; i++) {
    for (const mode of MODES) {
      const sample = await bootOnce(dir, mode, options);
      samples[mode].push(sample);
      console.log(`run ${i + 1}/${options.runs} ${mode.padEnd(7)} ${round(sample.ms)} ms (in-process ${sample.inProcessMs} ms)`);
    }
  }
  return Object.fromEntries(
    MODES.map((mode) => [
      mode,
      { medianMs: round(median(samples[mode].map((s) => s.ms))), samplesMs: samples[mode].map((s) => round(s.ms)), inProcessSamplesMs: samples[mode].map((s) => s.inProcessMs) },
    ]),
  );
}

function summaryOf(result) {
  const { off, require: req } = result.modes;
  return [
    `### Cold start (${result.controllers} controllers x ${result.routes} routes, ${result.runs} runs)`,
    '',
    '| manifest mode | median time-to-listening |',
    '| --- | --- |',
    `| off | ${off.medianMs} ms |`,
    `| require | ${req.medianMs} ms |`,
    '',
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  // Inside the repo, so the app resolves the workspace packages through the root node_modules.
  const cache = join(repoRoot, 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, 'spinajs-cold-start-'));
  const cleanup = () => {
    killChildren();
    if (!options.keep) rmSync(dir, { recursive: true, force: true });
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      cleanup();
      process.exit(1);
    });
  }

  try {
    console.log(`generating ${options.controllers} controllers x ${options.routes} routes in ${dir}`);
    generateApp(dir, options);
    console.log(`built (tsc + spinajs build) in ${buildApp(dir)} ms`);
    const modes = await measure(dir, options);
    const result = {
      controllers: options.controllers,
      routes: options.routes,
      runs: options.runs,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      generatedAt: new Date().toISOString(),
      modes,
    };
    writeFileSync(options.out, JSON.stringify(result, null, 2) + '\n');
    const summary = summaryOf(result);
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
