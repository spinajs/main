import 'mocha';
import { expect } from 'chai';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Manifest } from '@spinajs/manifest';
import { Build } from '../src/cli/Build.js';

const fixtures = fileURLToPath(new URL('../../compiler/test/fixtures/', import.meta.url));
const appBasic = join(fixtures, 'app-basic/tsconfig.json');
const reportWarning = join(fixtures, 'report-warning/tsconfig.build.json');

class Captured extends Build {
  public output = '';
  protected override write(text: string): void {
    this.output += text;
  }
}

describe('build', function () {
  this.timeout(120000);

  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spinajs-build-'));
    process.exitCode = undefined;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('writes app.manifest.json for the app and prints a summary', async () => {
    const out = join(dir, 'app.manifest.json');
    const cmd = new Captured();
    await cmd.execute({ tsconfig: appBasic, out, schemas: true });

    const manifest = JSON.parse(readFileSync(out, 'utf8')) as Manifest;
    expect(manifest.app.name).to.equal('app-basic');
    expect(manifest.controllers.length).to.be.greaterThan(0);
    expect(cmd.output).to.match(/controllers\s+\d+/);
    expect(cmd.output).to.match(/routes\s+\d+/);
    expect(cmd.output).to.match(/diagnostics\s+\d+ error\(s\), \d+ warning\(s\), \d+ info/);
    expect(process.exitCode).to.equal(undefined);
  });

  it('--no-schemas derives fewer schemas than the default', async () => {
    const read = (file: string) => Object.keys((JSON.parse(readFileSync(file, 'utf8')) as Manifest).schemas);
    await new Captured().execute({ tsconfig: appBasic, out: join(dir, 'on.json'), schemas: true });
    await new Captured().execute({ tsconfig: appBasic, out: join(dir, 'off.json'), schemas: false });
    expect(read(join(dir, 'off.json')).length).to.be.lessThan(read(join(dir, 'on.json')).length);
  });

  it('exits 0 on warnings and prints them as "warning CODE file:line message"', async () => {
    const cmd = new Captured();
    await cmd.execute({ tsconfig: reportWarning, out: join(dir, 'm.json'), schemas: true });
    expect(cmd.output).to.match(/^warning SCH001 src\/index\.ts:\d+ .+$/m);
    expect(process.exitCode).to.equal(undefined);
  });

  it('--fail-on-warning exits 1 when a warning is reported', async () => {
    const cmd = new Captured();
    await cmd.execute({ tsconfig: reportWarning, out: join(dir, 'm.json'), schemas: true, failOnWarning: true });
    expect(process.exitCode).to.equal(1);
    expect(existsSync(join(dir, 'm.json'))).to.equal(true);
  });
});
