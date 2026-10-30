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
  root: ProbeImport[];
  subpath: ProbeImport[];
  compiler: string;
}

const LIB = `${resolve(process.cwd(), 'lib')}${sep}`;

const fromReflection = (i: ProbeImport): boolean => i.parent.startsWith('file:') && fileURLToPath(i.parent).startsWith(LIB);

/**
 * Out of process and on the built package: ts-node, which runs this suite, loads typescript itself. Only reflection's
 * own imports count: `@spinajs/configuration` still imports glob.
 */
describe('reflection does not load typescript or glob on import', function () {
  this.timeout(60000);

  let probe: ProbeResult;

  before(() => {
    const run = spawnSync(process.execPath, [resolve(process.cwd(), 'test', 'support', 'probe.lazy-imports.mjs')], { cwd: process.cwd(), encoding: 'utf8', timeout: 55000 });
    const match = /<<JSON\n([\s\S]*?)\nJSON>>/.exec(run.stdout);
    if (!match) throw new Error(`probe failed (${String(run.status)}):\n${run.stdout}\n${run.stderr}`);
    probe = JSON.parse(match[1]) as ProbeResult;
  });

  it('imports @spinajs/reflection without typescript or glob', () => {
    expect(probe.root.filter(fromReflection)).to.deep.equal([]);
  });

  it('loads typescript only through the ./typescript subpath', () => {
    expect(probe.compiler).to.equal('function');
    expect(probe.subpath.filter(fromReflection).map((i) => i.specifier)).to.deep.equal(['typescript']);
  });
});

describe('reflection without glob installed', function () {
  this.timeout(60000);

  it('fails the first directory scan naming the optional peer and the manifest alternative', () => {
    const run = spawnSync(process.execPath, [resolve(process.cwd(), 'test', 'support', 'probe.missing-glob.mjs')], { cwd: process.cwd(), encoding: 'utf8', timeout: 55000 });
    const match = /<<JSON\n([\s\S]*?)\nJSON>>/.exec(run.stdout);
    if (!match) throw new Error(`probe failed (${String(run.status)}):\n${run.stdout}\n${run.stderr}`);
    const result = JSON.parse(match[1]) as { error?: { name: string; message: string } };

    expect(result.error?.name).to.equal('ReflectionException');
    expect(result.error?.message).to.include('optional peer dependency `glob`');
    expect(result.error?.message).to.include('system.manifest.mode');
  });
});
