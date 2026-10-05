import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SNAPSHOT = resolve(process.cwd(), 'test', '__snapshots__', 'swagger-authz.json');

interface Probed {
  route: string;
  extensions: Record<string, unknown>;
  access: string | null;
  responses: string[];
  swaggerAccess: Record<string, unknown> | null;
}

/**
 * The document of a fixture built with the real authz-http decorators, in a fresh process so
 * importing authz-http cannot leak into the other suites. Rewrite the snapshot with
 * `UPDATE_SNAPSHOTS=1`.
 */
describe('Swagger @Access snapshot', function () {
  this.timeout(120000);

  let routes: Probed[];

  before(() => {
    const probe = resolve(process.cwd(), 'test', 'support', 'probe.access-snapshot.ts');
    const run = spawnSync(process.execPath, ['--loader', 'ts-node/esm', '--experimental-specifier-resolution=node', probe], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, TS_NODE_PROJECT: resolve(process.cwd(), 'tsconfig.json') },
    });
    const match = /<<JSON\n([\s\S]*?)\nJSON>>/.exec(run.stdout);
    if (!match) throw new Error(`probe failed (${run.status}):\n${run.stdout}\n${run.stderr}`);
    routes = JSON.parse(match[1]);
  });

  it('describes every route like authz-http swaggerAccess does', () => {
    expect(routes.length).to.be.greaterThan(7);
    for (const r of routes) {
      expect(r.extensions, r.route).to.deep.equal(r.swaggerAccess ?? {});
    }
  });

  it('matches the committed snapshot', () => {
    const actual = routes.map(({ swaggerAccess, ...rest }) => rest);
    if (process.env.UPDATE_SNAPSHOTS) writeFileSync(SNAPSHOT, `${JSON.stringify(actual, null, 2)}\n`);
    expect(existsSync(SNAPSHOT), 'snapshot file is missing; run with UPDATE_SNAPSHOTS=1').to.equal(true);
    expect(actual).to.deep.equal(JSON.parse(readFileSync(SNAPSHOT, 'utf8')));
  });
});
