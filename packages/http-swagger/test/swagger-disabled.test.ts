import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

interface Answer {
  status: number;
  body: string;
}

interface Probed {
  routes: number | null;
  spec: Answer;
  ui: Answer;
  uiDist: number;
  uiInit: number;
}

/** Each case in a fresh process: the package config is read once per process and DI keeps the first server. */
function probe(mode: 'enabled' | 'disabled' | 'override'): Probed {
  const run = spawnSync(process.execPath, ['--loader', 'ts-node/esm', '--experimental-specifier-resolution=node', resolve(process.cwd(), 'test', 'support', 'probe.disabled.ts'), mode], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, TS_NODE_PROJECT: resolve(process.cwd(), 'tsconfig.json') },
  });
  const match = /<<JSON\n([\s\S]*?)\nJSON>>/.exec(run.stdout);
  if (!match) throw new Error(`probe failed (${run.status}):\n${run.stdout}\n${run.stderr}`);
  return JSON.parse(match[1]) as Probed;
}

describe('Swagger with http.swagger.enabled: false', function () {
  this.timeout(240000);

  let disabled: Probed;
  let enabled: Probed;
  let override: Probed;

  before(() => {
    disabled = probe('disabled');
    enabled = probe('enabled');
    override = probe('override');
  });

  it('registers no docs route', () => {
    expect(disabled.routes).to.equal(0);
    expect(disabled.spec.status).to.equal(404);
    expect(disabled.spec.body).to.not.contain('Swagger documentation is disabled');
    expect(disabled.ui.status).to.equal(404);
    expect(disabled.ui.body).to.not.contain('Swagger documentation is disabled');
  });

  it('serves no static files under /docs/ui and /docs/static', () => {
    expect(disabled.uiDist).to.equal(404);
    expect(disabled.uiInit).to.equal(404);
  });

  it('serves the routes and the static files when enabled', () => {
    expect(enabled.routes).to.equal(2);
    expect(enabled.spec.status).to.equal(200);
    expect(enabled.ui.status).to.equal(200);
    expect(enabled.uiDist).to.equal(200);
    expect(enabled.uiInit).to.equal(200);
  });

  it('an IsEnabled override hides the routes but, with the key on, leaves the static files served', () => {
    expect(override.routes).to.equal(0);
    expect(override.spec.status).to.equal(404);
    expect(override.uiDist).to.equal(200);
    expect(override.uiInit).to.equal(200);
  });
});
