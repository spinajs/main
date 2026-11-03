import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

interface ProbeResult {
  unsupported?: string;
  body?: unknown;
  error?: { name: string; message: string };
  packages: string[];
}

/** Needed only to render a view, zip or unzip, parse a multipart form, a CSV upload, or XML. */
const LOADED_ON_FIRST_USE = ['pug', '@babel/parser', '@babel/types', 'archiver', 'unzipper', 'formidable', 'csv', 'csv-parse', 'csv-stringify', 'fast-xml-parser'];

/** Out of process and on the built packages: this process has loaded most of them already. */
function probe(): ProbeResult {
  const run = spawnSync(process.execPath, [resolve(process.cwd(), 'test', 'support', 'boot-graph', 'probe.mjs')], { cwd: process.cwd(), encoding: 'utf8', timeout: 110000 });
  const match = /<<JSON\n([\s\S]*?)\nJSON>>/.exec(run.stdout);
  if (!match) throw new Error(`probe failed (${String(run.status)}):\n${run.stdout}\n${run.stderr}`);
  const result = JSON.parse(match[1]) as ProbeResult;
  if (result.unsupported) throw new Error(result.unsupported);
  return result;
}

describe('boot module graph', function () {
  this.timeout(120000);

  let result: ProbeResult;

  before(() => {
    result = probe();
  });

  it('boots and serves a request', () => {
    expect(result.error).to.equal(undefined);
    expect(result.body).to.deep.equal({ value: 'ok' });
    expect(result.packages).to.include.members(['express', '@spinajs/templates-pug', '@spinajs/fs']);
  });

  it('loads no dependency that only a view, zip, form, CSV or XML request needs', () => {
    expect(result.packages.filter((p) => LOADED_ON_FIRST_USE.includes(p))).to.deep.equal([]);
  });

  it('loads neither glob nor minimatch: in require mode the manifest says what to load', () => {
    expect(result.packages.filter((p) => ['glob', 'minimatch'].includes(p))).to.deep.equal([]);
  });
});
