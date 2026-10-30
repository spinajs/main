import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

interface ProbeImport {
  specifier: string;
  parent: string;
}

interface ProbeResult {
  body: unknown;
  imports: ProbeImport[];
}

const HTTP_LIB = `${resolve(process.cwd(), 'lib')}${sep}`;

const fromHttp = (i: ProbeImport): boolean => i.parent.startsWith('file:') && fileURLToPath(i.parent).startsWith(HTTP_LIB);

/**
 * Out of process and on the built packages: ts-node, which runs this suite, loads typescript itself. glob is only
 * checked for http: `@spinajs/configuration` still imports it.
 */
describe('typescript is not loaded at runtime in require mode', function () {
  this.timeout(120000);

  let probe: ProbeResult;

  before(() => {
    const run = spawnSync(process.execPath, [resolve(process.cwd(), 'test', 'support', 'no-typescript', 'probe.mjs')], { cwd: process.cwd(), encoding: 'utf8', timeout: 110000 });
    const match = /<<JSON\n([\s\S]*?)\nJSON>>/.exec(run.stdout);
    if (!match) throw new Error(`probe failed (${String(run.status)}):\n${run.stdout}\n${run.stderr}`);
    probe = JSON.parse(match[1]) as ProbeResult;
  });

  it('serves a manifest-listed controller with arguments bound by the manifest names', () => {
    expect(probe.body).to.deep.equal({ value: 'ok' });
  });

  it('http imports neither typescript nor glob', () => {
    expect(probe.imports.filter(fromHttp)).to.deep.equal([]);
  });

  it('nothing imports typescript', () => {
    expect(probe.imports.filter((i) => i.specifier === 'typescript' || i.specifier.startsWith('typescript/'))).to.deep.equal([]);
  });
});
