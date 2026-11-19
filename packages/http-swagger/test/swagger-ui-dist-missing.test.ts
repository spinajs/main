import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

interface Probed {
  uiDist: number;
  looked: string;
  log: string[];
}

const NOT_INSTALLED = 'swagger-ui-dist is not installed';
const GENERIC = 'static file path';

/** Each case in a fresh process, with WORKSPACE_ROOT_PATH at a folder that has no swagger-ui-dist anywhere above it. */
function probe(root: string, mode: 'enabled' | 'disabled', urls: 'local' | 'cdn', entry: 'package' | 'app' = 'package'): Probed {
  const run = spawnSync(process.execPath, ['--loader', 'ts-node/esm', '--experimental-specifier-resolution=node', resolve(process.cwd(), 'test', 'support', 'probe.ui-dist.ts'), mode, urls, entry], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, TS_NODE_PROJECT: resolve(process.cwd(), 'tsconfig.json'), WORKSPACE_ROOT_PATH: root },
  });
  const match = /<<JSON\n([\s\S]*?)\nJSON>>/.exec(run.stdout);
  if (!match) throw new Error(`probe failed (${run.status}):\n${run.stdout}\n${run.stderr}`);
  const log = `${run.stdout}\n${run.stderr}`.split(/\r?\n/).filter((line) => / WARN /.test(line));
  return { ...(JSON.parse(match[1]) as Omit<Probed, 'log'>), log };
}

describe('Swagger without swagger-ui-dist installed', function () {
  this.timeout(360000);

  let root: string;
  let enabled: Probed;
  let disabled: Probed;
  let cdn: Probed;
  let app: Probed;

  before(() => {
    root = mkdtempSync(resolve(tmpdir(), 'no-swagger-ui-dist-'));
    enabled = probe(root, 'enabled', 'local');
    disabled = probe(root, 'disabled', 'local');
    cdn = probe(root, 'enabled', 'cdn');
    app = probe(root, 'enabled', 'local', 'app');
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it('says once what is missing, what it disables and what to do, instead of the generic line', () => {
    const lines = enabled.log.filter((line) => line.includes(NOT_INSTALLED));
    expect(lines, enabled.log.join('\n')).to.have.length(1);
    expect(lines[0]).to.contain(`every node_modules folder from ${root} upwards`);
    expect(lines[0]).to.contain(enabled.looked);
    expect(lines[0]).to.contain('npm install swagger-ui-dist');
    expect(lines[0]).to.contain('https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/');
    expect(enabled.log.filter((line) => line.includes(GENERIC))).to.deep.equal([]);
    expect(enabled.uiDist).to.equal(404);
  });

  it('says nothing when swagger is disabled', () => {
    expect(disabled.log.filter((line) => line.includes(NOT_INSTALLED) || line.includes(GENERIC))).to.deep.equal([]);
  });

  it('says nothing when the app serves /docs/ui from a folder of its own', () => {
    expect(app.log.filter((line) => line.includes(NOT_INSTALLED) || line.includes(GENERIC))).to.deep.equal([]);
  });

  it('says nothing when the UI loads its files from elsewhere', () => {
    expect(cdn.log.filter((line) => line.includes(NOT_INSTALLED) || line.includes(GENERIC))).to.deep.equal([]);
  });
});
