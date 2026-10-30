import 'mocha';
import { expect } from 'chai';
import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const PACKAGE = resolve(process.cwd());

/** The source twins of what @spinajs/telemetry's config fragment adds to `system.dirs.controllers`. */
const SCANNED_DIRS = ['src/controllers'];

function controllerFiles(dir: string): string[] {
  return readdirSync(join(PACKAGE, dir), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .map((f) => pathToFileURL(join(PACKAGE, dir, f)).href);
}

/**
 * An app reaches @spinajs/telemetry through the controller scan of its config fragment and may never import the package
 * entry. Every other suite shares one process with files that import `src/index.ts`, so the scan alone is checked in
 * a process of its own.
 */
describe('@spinajs/telemetry: the controller scan registers the metrics bootstrappers, request middleware and perf sink', function () {
  this.timeout(120000);

  it('registers the metrics bootstrappers, request middleware and perf sink when only the scanned controller files are imported', async () => {
    const script = [
      `for (const f of ${JSON.stringify([...SCANNED_DIRS.flatMap(controllerFiles)])}) await import(f);`,
      `const { DI } = await import('@spinajs/di');`,
      `const found = {};`,
      `const { Bootstrapper } = await import('@spinajs/di');`,
      `found['Bootstrapper'] = (DI.RootContainer.getRegisteredTypes(Bootstrapper) ?? []).map((t) => t.name);`,
      `const { ServerMiddleware } = await import('@spinajs/http');`,
      `found['ServerMiddleware'] = (DI.RootContainer.getRegisteredTypes(ServerMiddleware) ?? []).map((t) => t.name);`,
      `const { PerfSink } = await import('@spinajs/log');`,
      `found['PerfSink'] = (DI.RootContainer.getRegisteredTypes(PerfSink) ?? []).map((t) => t.name);`,
      `console.log(JSON.stringify(found));`,
      `process.exit(0);`,
    ].join('\n');

    const { stdout } = await run(process.execPath, ['--no-warnings', '--experimental-specifier-resolution=node', '--loader=ts-node/esm', '--input-type=module', '-e', script], {
      cwd: PACKAGE,
      env: { ...process.env, TS_NODE_PROJECT: 'tsconfig.json' },
      timeout: 110000,
    });
    const found = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as Record<string, string[]>;

    expect(found.Bootstrapper).to.include('TelemetryBootstrapper');
    expect(found.Bootstrapper).to.include('TelemetryServiceTokenBootstrapper');
    expect(found.ServerMiddleware).to.include('TelemetryMiddleware');
    expect(found.PerfSink).to.include('PromMetricSink');
  });
});
