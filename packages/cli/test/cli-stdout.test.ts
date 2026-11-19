import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';

/**
 * The bin in a child process with a JSON logger on stdout, as a production config has it. The fixture imports the
 * packages by file URL because nothing resolves `@spinajs/*` from a temporary directory.
 */
describe('spinajs bin: log lines on stderr, command output on stdout', function () {
  this.timeout(180000);

  const bin = resolve('lib/mjs/cli.js');
  const lib = (pkg: string) => pathToFileURL(fs.realpathSync(resolve('..', pkg, 'lib', 'mjs', 'index.js'))).href;
  const dumped = { name: 'fixture', ports: [8080, 8081], nested: { enabled: true } };
  let dir: string;

  before(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'spinajs-cli-stdout-'));
    fs.mkdirSync(join(dir, 'config'));
    fs.mkdirSync(join(dir, 'commands'));
    fs.writeFileSync(join(dir, 'package.json'), '{ "type": "module" }');

    fs.writeFileSync(
      join(dir, 'commands', 'probe.js'),
      `import { CliCommand, Command } from '${lib('cli')}';
export class ProbeCommand extends CliCommand {
  async execute() { console.log('probe output'); }
}
Command('probe', 'prints one line')(ProbeCommand);

export class FailingCommand extends CliCommand {
  async execute() { throw new Error('the probe failed on purpose'); }
}
Command('probe-fail', 'throws')(FailingCommand);
`,
    );

    // the dump command ships in the cli package's own lib directory
    fs.writeFileSync(
      join(dir, 'config', 'app.js'),
      `import '${lib('log')}';
export default {
  logger: { targets: [{ name: 'Json', type: 'JsonTarget' }], rules: [{ name: '*', level: 'info', target: 'Json' }] },
  system: { dirs: { cli: [${JSON.stringify(join(dir, 'commands'))}, ${JSON.stringify(resolve('lib', 'mjs', 'cli'))}] } },
  dumped: ${JSON.stringify(dumped)},
};
`,
    );
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function run(...args: string[]) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.WORKSPACE_ROOT_PATH;

    return spawnSync(process.execPath, [bin, ...args], { cwd: dir, env, encoding: 'utf-8', timeout: 150000 });
  }

  it("puts only the command's output on stdout and the log lines on stderr", () => {
    const result = run('probe');

    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.match(/^probe output\r?\n$/);
    expect(result.stderr).to.contain('Welcome to spinajs cli...');
  });

  it('configuration:dump prints the value as one JSON document on stdout', () => {
    const result = run('configuration:dump', '-p', 'dumped');

    expect(result.status, result.stderr).to.equal(0);
    // the configuration records which file each root section came from
    const { __file__: source, ...value } = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(value).to.eql(dumped);
    expect(source).to.eql([join(dir, 'config', 'app.js')]);
    expect(result.stderr).to.contain('Welcome to spinajs cli...');
    expect(result.stderr).to.not.contain('8081');
  });

  it('a failing command exits non-zero with its error on stderr and nothing on stdout', () => {
    const result = run('probe-fail');

    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.contain('the probe failed on purpose');
    expect(result.stdout).to.equal('');
  });
});
