import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

interface Probed {
  failures: string[];
  spec: number | string;
}

/** In a fresh process, so importing authz-http cannot leak into the other suites. */
describe('Swagger routes under authz.http.unguardedRoutes: throw', function () {
  this.timeout(120000);

  let probed: Probed;

  before(() => {
    const probe = resolve(process.cwd(), 'test', 'support', 'probe.unguarded-routes.ts');
    const run = spawnSync(process.execPath, ['--loader', 'ts-node/esm', '--experimental-specifier-resolution=node', probe], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, TS_NODE_PROJECT: resolve(process.cwd(), 'tsconfig.json') },
    });
    const match = /<<JSON\n([\s\S]*?)\nJSON>>/.exec(run.stdout);
    if (!match) throw new Error(`probe failed (${run.status}):\n${run.stdout}\n${run.stderr}`);
    probed = JSON.parse(match[1]);
  });

  it('boots without stopping the server', () => {
    expect(probed.failures).to.deep.equal([]);
  });

  it('keeps serving the spec', () => {
    expect(probed.spec).to.equal(200);
  });
});
