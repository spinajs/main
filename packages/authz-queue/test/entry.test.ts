import 'mocha';

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect } from 'chai';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('package entries (built package)', () => {
  it('the root does not load @spinajs/authz-orm or the job resource; @spinajs/authz-queue/jobs does', () => {
    const { exports } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { exports: Record<string, { import: string }> };
    const entry = (path: string): string => pathToFileURL(join(pkgDir, exports[path].import)).href;

    // A child process: in this one every test file's imports share the registry and the module cache.
    const script = [
      "import { registerHooks } from 'node:module';",
      'const urls = [];',
      'registerHooks({ resolve: (specifier, context, next) => { const r = next(specifier, context); urls.push(r.url); return r; } });',
      "const ormLoaded = () => urls.some((u) => /[\\\\/]authz-orm[\\\\/]/.test(u));",
      "const jobLoaded = () => urls.some((u) => /[\\\\/]job[\\\\/]job-resource\\.js$/.test(u));",
      `await import(${JSON.stringify(entry('.'))});`,
      'const root = { orm: ormLoaded(), job: jobLoaded() };',
      `const jobs = await import(${JSON.stringify(entry('./jobs'))});`,
      "console.log('RESULT ' + JSON.stringify({ root, jobs: { orm: ormLoaded(), job: jobLoaded(), hook: typeof jobs.AuthzQueueTrackingHook } }));",
      'process.exit(0);',
    ].join('\n');

    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: pkgDir, encoding: 'utf8', timeout: 60000 });

    const line = out.split(/\r?\n/).find((l) => l.startsWith('RESULT '));
    expect(JSON.parse(line!.slice('RESULT '.length))).to.deep.equal({ root: { orm: false, job: false }, jobs: { orm: true, job: true, hook: 'function' } });
  });
});
