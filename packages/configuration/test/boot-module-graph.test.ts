import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

interface ProbeResult {
  unsupported?: string;
  values?: Record<string, unknown>;
  error?: { name: string; message: string };
  packages: string[];
}

/** Out of process and on the built packages: this process has loaded glob already. */
function probe(mode: string): ProbeResult {
  const run = spawnSync(process.execPath, [resolve(process.cwd(), 'test', 'support', 'boot-graph', 'probe.mjs'), mode], { cwd: process.cwd(), encoding: 'utf8', timeout: 110000 });
  const match = /<<JSON\n([\s\S]*?)\nJSON>>/.exec(run.stdout);
  if (!match) throw new Error(`probe failed (${String(run.status)}):\n${run.stdout}\n${run.stderr}`);
  const result = JSON.parse(match[1]) as ProbeResult;
  if (result.unsupported) throw new Error(result.unsupported);
  return result;
}

const LISTING = ['glob', 'minimatch'];

describe('configuration boot module graph', function () {
  this.timeout(240000);

  const loaded = { dep: { value: 'app', list: ['package'] }, depExtra: true, app: true, json: true };

  it('reads package and app config files from a manifest in require mode without loading glob or minimatch', () => {
    const result = probe('require');
    expect(result.error).to.equal(undefined);
    expect(result.values).to.deep.equal(loaded);
    expect(result.packages).to.include('@spinajs/configuration');
    expect(result.packages.filter((p) => LISTING.includes(p))).to.deep.equal([]);
  });

  it('still globs node_modules in off mode, to the same configuration', () => {
    const result = probe('off');
    expect(result.error).to.equal(undefined);
    expect(result.values).to.deep.equal(loaded);
    expect(result.packages).to.include('glob');
  });
});
