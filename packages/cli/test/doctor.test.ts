import 'mocha';
import { expect } from 'chai';
import { resolve } from 'node:path';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { DoctorCommand } from '../src/cli/Doctor.js';

const fixture = (name: string) => resolve(process.cwd(), 'test/fixtures/doctor', name);
const MANIFEST = fixture('app.manifest.json');

class DoctorConf extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '${message}' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      system: { dirs: { controllers: ['/definitely/missing'] } },
    };
  }
}

describe('spinajs doctor', function () {
  this.timeout(60000);

  let lines: string[];
  let cmd: DoctorCommand;

  beforeEach(async () => {
    DI.clearCache();
    DI.register(DoctorConf).as(Configuration);
    await DI.resolve(Configuration);
    lines = [];
    cmd = await DI.resolve(DoctorCommand);
    (cmd as unknown as { Print: (l: string) => void }).Print = (l) => lines.push(l);
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('prints text diagnostics and sets exitCode 1 on errors', async () => {
    await cmd.execute({ manifest: MANIFEST, format: 'text', failOn: 'error' });
    expect(lines.some((l) => l.startsWith('error   HTTP002'))).to.be.true;
    expect(lines.at(-1)).to.match(/^\d+ error\(s\), \d+ warning\(s\), \d+ info$/);
    expect(process.exitCode).to.equal(1);
  });

  it('json format is one parseable line', async () => {
    await cmd.execute({ manifest: MANIFEST, format: 'json', failOn: 'error' });
    expect(lines).to.have.length(1);
    const parsed = JSON.parse(lines[0]) as { diagnostics: { code: string }[]; summary: { error: number } };
    expect(parsed.diagnostics.map((d) => d.code)).to.include('HTTP002');
    expect(parsed.summary.error).to.be.greaterThan(0);
  });

  it('github format emits annotations', async () => {
    await cmd.execute({ manifest: MANIFEST, format: 'github', failOn: 'error' });
    expect(lines.find((l) => l.includes('title=HTTP002'))).to.match(/^::error file=.+,line=\d+,col=\d+,title=HTTP002::/);
  });

  it('--config adds CFG002 for a missing system.dirs entry', async () => {
    await cmd.execute({ manifest: MANIFEST, format: 'json', failOn: 'error', config: true });
    const parsed = JSON.parse(lines[0]) as { diagnostics: { code: string; message: string }[] };
    expect(parsed.diagnostics.map((d) => d.message)).to.include("system.dirs.controllers entry '/definitely/missing' does not exist");
    expect(parsed.diagnostics.find((d) => d.message.includes('/definitely/missing'))?.code).to.equal('CFG002');
  });

  it('does not check the configuration without --config', async () => {
    await cmd.execute({ manifest: MANIFEST, format: 'json', failOn: 'error' });
    const parsed = JSON.parse(lines[0]) as { diagnostics: { code: string }[] };
    expect(parsed.diagnostics.map((d) => d.code)).to.not.include('CFG002');
  });

  it('--fail-on warning fails on warnings, and a clean manifest leaves exitCode unset', async () => {
    await cmd.execute({ manifest: fixture('clean.manifest.json'), format: 'text', failOn: 'error' });
    expect(process.exitCode).to.equal(undefined);
    await cmd.execute({ manifest: fixture('warning-only.manifest.json'), format: 'text', failOn: 'error' });
    expect(process.exitCode).to.equal(undefined);
    await cmd.execute({ manifest: fixture('warning-only.manifest.json'), format: 'text', failOn: 'warning' });
    expect(process.exitCode).to.equal(1);
  });

  it('a missing manifest file is a single error line and exitCode 1', async () => {
    const missing = resolve('/nowhere/app.manifest.json');
    await cmd.execute({ manifest: missing, format: 'text', failOn: 'error' });
    expect(lines).to.have.length(2);
    expect(lines[0].split(' ').filter(Boolean).slice(0, 2)).to.deep.equal(['error', 'DOCTOR']);
    expect(lines[0]).to.contain(`Cannot read manifest ${missing}: run spinajs build first`);
    expect(lines[1]).to.equal('1 error(s), 0 warning(s), 0 info');
    expect(process.exitCode).to.equal(1);
  });
});
