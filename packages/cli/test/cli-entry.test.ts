import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../lib/cli.js', import.meta.url));
const cliPackage = fileURLToPath(new URL('..', import.meta.url));

const noStack = (text: string) => expect(text).to.not.match(/^\s+at /m);

describe('the cli entry point', function () {
  this.timeout(30000);

  let cwd: string;
  const run = (...args: string[]) => spawnSync(process.execPath, [entry, ...args], { cwd, encoding: 'utf8' });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  describe('outside an application', () => {
    beforeEach(() => {
      cwd = mkdtempSync(join(tmpdir(), 'spinajs-cli-entry-'));
    });

    it('keeps --version working with no command to load', () => {
      const result = run('--version');
      expect(result.status, result.stderr).to.equal(0);
      expect(result.stdout.trim()).to.match(/^\d+\.\d+\.\d+/);
    });

    it('prints why it failed instead of exiting silently', () => {
      const result = run('no-such-command');
      expect(result.status).to.not.equal(0);
      expect(result.stderr).to.include('no-such-command');
      noStack(result.stderr);
    });

    it('refuses a command that needs an application, and says none was found', () => {
      const result = run('migrate', 'up');
      expect(result.status).to.not.equal(0);
      expect(result.stderr).to.include('no application found');
      expect(result.stderr).to.include('migrate');
      noStack(result.stderr);
    });

    it('prints a usage error with its help and no stack', () => {
      const result = run('--no-such-option');
      expect(result.status).to.not.equal(0);
      expect(result.stderr).to.include('--no-such-option');
      expect(result.stderr).to.include('Usage: spinajs');
      noStack(result.stderr);
    });
  });

  describe('compile cache', () => {
    const withTmp = (tmp: string, extra: NodeJS.ProcessEnv = {}) => {
      const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, ...extra };
      delete env.NODE_COMPILE_CACHE;
      return spawnSync(process.execPath, [entry, '--version'], { cwd, encoding: 'utf8', env });
    };
    const cacheFiles = (tmp: string) => (existsSync(join(tmp, 'node-compile-cache')) ? readdirSync(join(tmp, 'node-compile-cache'), { recursive: true }).length : 0);

    beforeEach(() => {
      cwd = mkdtempSync(join(tmpdir(), 'spinajs-cli-cache-'));
    });

    it('keeps the compiled modules in the temp dir for the next start', () => {
      const tmp = join(cwd, 'tmp');
      mkdirSync(tmp);
      const result = withTmp(tmp);
      expect(result.status, result.stderr).to.equal(0);
      expect(cacheFiles(tmp)).to.be.greaterThan(1);
    });

    it('keeps none with NODE_DISABLE_COMPILE_CACHE=1', () => {
      const tmp = join(cwd, 'tmp');
      mkdirSync(tmp);
      const result = withTmp(tmp, { NODE_DISABLE_COMPILE_CACHE: '1' });
      expect(result.status, result.stderr).to.equal(0);
      expect(cacheFiles(tmp)).to.equal(0);
    });

    it('starts as usual when the cache dir cannot be created', () => {
      const tmp = join(cwd, 'not-a-dir');
      writeFileSync(tmp, '');
      const result = withTmp(tmp);
      const reference = run('--version');
      expect(result.status, result.stderr).to.equal(0);
      expect(result.stdout).to.equal(reference.stdout);
      expect(result.stderr).to.equal(reference.stderr);
    });
  });

  describe('in an application with no @spinajs/log loaded', () => {
    beforeEach(() => {
      cwd = mkdtempSync(join(tmpdir(), 'spinajs-cli-app-'));
      mkdirSync(join(cwd, 'node_modules', '@spinajs'), { recursive: true });
      symlinkSync(cliPackage, join(cwd, 'node_modules', '@spinajs', 'cli'), 'junction');
      writeFileSync(join(cwd, 'package.json'), '{ "name": "app", "type": "module" }');
    });

    it('prints an unknown command', () => {
      const result = run('no-such-command');
      expect(result.status).to.not.equal(0);
      expect(result.stderr).to.include("unknown command 'no-such-command'");
      noStack(result.stderr);
    });

    it('prints a failed command by its message alone', () => {
      const result = run('manifest:diff', join(cwd, 'no-base.json'), join(cwd, 'no-head.json'));
      expect(result.status).to.not.equal(0);
      expect(result.stderr).to.include('no-base.json');
      noStack(result.stderr);
    });
  });
});
