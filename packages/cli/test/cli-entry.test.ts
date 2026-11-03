import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
    const cacheRoot = () => join(cwd, 'cache');
    const cacheDir = () => join(cacheRoot(), 'spinajs', 'compile-cache');
    // XDG_CACHE_HOME is the per-user cache root on POSIX, LOCALAPPDATA on Windows; the temp dir must stay unused.
    const start = (extra: NodeJS.ProcessEnv = {}) => {
      const tmp = join(cwd, 'tmp');
      mkdirSync(tmp, { recursive: true });
      const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, XDG_CACHE_HOME: cacheRoot(), LOCALAPPDATA: cacheRoot(), ...extra };
      if (!('NODE_COMPILE_CACHE' in extra)) delete env.NODE_COMPILE_CACHE;
      if (!('NODE_DISABLE_COMPILE_CACHE' in extra)) delete env.NODE_DISABLE_COMPILE_CACHE;
      return spawnSync(process.execPath, [entry, '--version'], { cwd, encoding: 'utf8', env });
    };
    const filesIn = (dir: string) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).length : 0);
    const startsAsUsual = (result: ReturnType<typeof start>) => {
      const reference = start({ NODE_DISABLE_COMPILE_CACHE: '1' });
      expect(result.status, result.stderr).to.equal(0);
      expect(result.stdout).to.equal(reference.stdout);
      expect(result.stderr).to.equal(reference.stderr);
    };

    beforeEach(() => {
      cwd = mkdtempSync(join(tmpdir(), 'spinajs-cli-cache-'));
    });

    it('keeps the compiled modules in the per-user cache dir, not in the shared temp dir', () => {
      const result = start();
      expect(result.status, result.stderr).to.equal(0);
      expect(filesIn(cacheDir())).to.be.greaterThan(1);
      expect(filesIn(join(cwd, 'tmp'))).to.equal(0);
    });

    it('keeps none with NODE_DISABLE_COMPILE_CACHE=1', () => {
      const result = start({ NODE_DISABLE_COMPILE_CACHE: '1' });
      expect(result.status, result.stderr).to.equal(0);
      expect(filesIn(cwd)).to.equal(1);
    });

    it('starts as usual when the cache dir cannot be created', () => {
      writeFileSync(cacheRoot(), '');
      startsAsUsual(start());
    });

    // Permission bits and owners: Windows keeps the per-user dir private through ACLs instead.
    if (process.platform !== 'win32') {
      it('leaves the cache off, and starts as usual, when other users can write to the cache dir', () => {
        mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
        chmodSync(cacheDir(), 0o777);
        startsAsUsual(start());
        expect(filesIn(cacheDir())).to.equal(0);
        expect(filesIn(join(cwd, 'tmp'))).to.equal(0);
      });

      it('leaves the cache off when a dir above it is group-writable', () => {
        mkdirSync(join(cacheRoot(), 'spinajs'), { recursive: true, mode: 0o700 });
        chmodSync(join(cacheRoot(), 'spinajs'), 0o775);
        startsAsUsual(start());
        expect(filesIn(join(cacheRoot(), 'spinajs'))).to.equal(0);
        expect(filesIn(join(cwd, 'tmp'))).to.equal(0);
      });
    }
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
