import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';

import { Bootstrapper, DI } from '@spinajs/di';
import { runPendingBootstrappers } from '../src/bootstrappers.js';

describe('runPendingBootstrappers', () => {
  const calls: string[] = [];

  class FirstBootstrapper extends Bootstrapper {
    public bootstrap(): void {
      calls.push('first');
    }
  }

  class LateBootstrapper extends Bootstrapper {
    public bootstrap(): void {
      calls.push('late');
    }
  }

  beforeEach(() => {
    calls.length = 0;
    DI.clearCache();
  });

  class NestedBootstrapper extends Bootstrapper {
    public bootstrap(): void {
      calls.push('nested');
    }
  }

  class RegisteringBootstrapper extends Bootstrapper {
    public bootstrap(): void {
      calls.push('registering');
      DI.register(NestedBootstrapper).as(Bootstrapper);
    }
  }

  afterEach(() => {
    [FirstBootstrapper, LateBootstrapper, RegisteringBootstrapper, NestedBootstrapper].forEach((t) => DI.unregister(t));
    DI.clearCache();
  });

  it('runs, in the same pass, a bootstrapper that another one registers while the pass runs', async () => {
    DI.register(RegisteringBootstrapper).as(Bootstrapper);

    await runPendingBootstrappers(new Set<object>());

    expect(calls).to.eql(['registering', 'nested']);
  });

  it('runs a bootstrapper registered after the first pass on the next pass, and each bootstrapper once', async () => {
    const ran = new Set<object>();
    DI.register(FirstBootstrapper).as(Bootstrapper);

    await runPendingBootstrappers(ran);
    DI.register(LateBootstrapper).as(Bootstrapper);
    await runPendingBootstrappers(ran);
    await runPendingBootstrappers(ran);

    expect(calls).to.eql(['first', 'late']);
  });
});

/**
 * The bin in a child process, from a directory outside the workspace: its only config file imports a module that
 * registers a Bootstrapper, and `--import` registers one before the bin runs, as a module the bin imports would.
 * The fixture imports the packages by file URL because nothing resolves `@spinajs/*` from a temporary directory.
 */
describe('spinajs bin and bootstrappers registered by config files', function () {
  this.timeout(180000);

  const bin = resolve('lib/mjs/cli.js');
  const lib = (pkg: string) => pathToFileURL(fs.realpathSync(resolve('..', pkg, 'lib', 'mjs', 'index.js'))).href;
  let dir: string;

  before(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'spinajs-cli-late-bootstrappers-'));
    fs.mkdirSync(join(dir, 'config'));
    fs.mkdirSync(join(dir, 'modules'));
    fs.writeFileSync(join(dir, 'package.json'), '{ "type": "module" }');

    fs.writeFileSync(
      join(dir, 'early.js'),
      `import { Bootstrapper, DI } from '${lib('di')}';
import { registerConfigurationSchema } from '${lib('configuration')}';
class EarlyBootstrapper extends Bootstrapper {
  bootstrap() {
    console.log('early bootstrapper ran');
    registerConfigurationSchema({ $id: 'late-bootstrappers-fixture', $configurationModule: 'fixture', type: 'object', properties: { port: { type: 'number' } } });
  }
}
DI.register(EarlyBootstrapper).as(Bootstrapper);
`,
    );

    fs.writeFileSync(
      join(dir, 'modules', 'late.js'),
      `import { Bootstrapper, DI } from '${lib('di')}';
import { registerConfigurationSchema } from '${lib('configuration')}';
class ConfigImportedBootstrapper extends Bootstrapper {
  async bootstrap() {
    console.log('config-imported bootstrapper ran');
    if (process.env.FIXTURE_LATE === 'throw') throw new Error('config-imported bootstrapper failed');
    if (process.env.FIXTURE_LATE === 'schema') {
      registerConfigurationSchema({ $id: 'late-bootstrappers-late-fixture', $configurationModule: 'lateFixture', type: 'object', properties: { enabled: { type: 'boolean' } } });
    }
    await import('./nested.js');
  }
}
DI.register(ConfigImportedBootstrapper).as(Bootstrapper);
`,
    );

    fs.writeFileSync(
      join(dir, 'modules', 'nested.js'),
      `import { Bootstrapper, DI } from '${lib('di')}';
class NestedBootstrapper extends Bootstrapper {
  bootstrap() { console.log('nested bootstrapper ran'); }
}
DI.register(NestedBootstrapper).as(Bootstrapper);
`,
    );

    // the bin needs a logger implementation, which an application's config files import as well
    fs.writeFileSync(
      join(dir, 'config', 'app.js'),
      `import '${lib('log')}';
import '../modules/late.js';
export default { fixture: { port: process.env.FIXTURE_PORT === 'invalid' ? 'not-a-number' : 8080 }, lateFixture: { enabled: 'yes' } };
`,
    );
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function run(env: Record<string, string> = {}) {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
    delete childEnv.WORKSPACE_ROOT_PATH;

    return spawnSync(process.execPath, ['--import', pathToFileURL(join(dir, 'early.js')).href, bin, '--version'], { cwd: dir, env: childEnv, encoding: 'utf-8', timeout: 150000 });
  }

  it('runs a bootstrapper that a config file imports, once, before the command', () => {
    const result = run();
    const lines = result.stdout.split(/\r?\n/);

    expect(result.status, result.stderr).to.equal(0);
    expect(lines.filter((l) => l === 'config-imported bootstrapper ran')).to.have.length(1);
    expect(lines.filter((l) => l === 'early bootstrapper ran')).to.have.length(1);
    expect(lines.indexOf('config-imported bootstrapper ran')).to.be.lessThan(lines.indexOf('0.0.0'));
  });

  it('runs a bootstrapper that a second-pass bootstrapper registers by importing its module', () => {
    const result = run();
    const lines = result.stdout.split(/\r?\n/);

    expect(result.status, result.stderr).to.equal(0);
    expect(lines.filter((l) => l === 'nested bootstrapper ran')).to.have.length(1);
    expect(lines.indexOf('nested bootstrapper ran')).to.be.lessThan(lines.indexOf('0.0.0'));
  });

  it('fails the run when a second-pass bootstrapper throws', () => {
    const result = run({ FIXTURE_LATE: 'throw' });

    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.contain('config-imported bootstrapper failed');
    expect(result.stdout).to.not.contain('0.0.0');
  });

  it('fails the run when a second-pass bootstrapper registers a schema that refuses a loaded value', () => {
    const result = run({ FIXTURE_LATE: 'schema' });

    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.contain('lateFixture.enabled must be boolean');
    expect(result.stdout).to.not.contain('0.0.0');
  });

  it('still fails the boot on a value that a schema registered by a first-pass bootstrapper refuses', () => {
    const result = run({ FIXTURE_PORT: 'invalid' });

    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.contain('fixture.port must be number');
    expect(result.stdout).to.not.contain('config-imported bootstrapper ran');
  });
});
