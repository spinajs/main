import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

interface ProbeResult {
  unsupported?: string;
  imports: Array<{ specifier: string; parent: string }>;
  paths?: string[];
  body?: unknown;
  error?: { name: string; message: string };
}

/** Out of process and on the built packages: ts-node, which runs this suite, loads typescript itself. */
describe('typescript is not loaded by a require-mode boot with http-swagger', function () {
  this.timeout(120000);

  let result: ProbeResult;

  before(() => {
    const run = spawnSync(process.execPath, [resolve(process.cwd(), 'test', 'support', 'no-typescript', 'probe.mjs')], { cwd: process.cwd(), encoding: 'utf8', timeout: 110000 });
    const match = /<<JSON\n([\s\S]*?)\nJSON>>/.exec(run.stdout);
    if (!match) throw new Error(`probe failed (${String(run.status)}):\n${run.stdout}\n${run.stderr}`);
    result = JSON.parse(match[1]) as ProbeResult;
    if (result.unsupported) throw new Error(result.unsupported);
  });

  it('builds the document from the manifest and serves the controller', () => {
    expect(result.error).to.equal(undefined);
    expect(result.paths).to.deep.equal(['/probe/ping']);
    expect(result.body).to.deep.equal({ value: 'ok' });
  });

  it('nothing imports typescript', () => {
    expect(result.imports).to.deep.equal([]);
  });
});
