import { expect } from 'chai';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileCacheDir, type CompileCacheHost } from '../src/compile-cache.js';

describe('compileCacheDir', () => {
  let work: string;
  const home = () => join(work, 'home');

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'spinajs-compile-cache-'));
    mkdirSync(home(), { mode: 0o700 });
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  describe('whatever the platform', () => {
    const host = (env: NodeJS.ProcessEnv): CompileCacheHost => ({ env, platform: 'linux', homedir: home(), uid: process.getuid?.() ?? 1000 });

    it('leaves the cache off and creates nothing with NODE_DISABLE_COMPILE_CACHE set', () => {
      expect(compileCacheDir(host({ NODE_DISABLE_COMPILE_CACHE: '1' }))).to.equal(undefined);
      expect(existsSync(join(home(), '.cache'))).to.equal(false);
    });

    it('leaves the dir to Node when NODE_COMPILE_CACHE names one', () => {
      expect(compileCacheDir(host({ NODE_COMPILE_CACHE: join(work, 'mine') }))).to.equal(undefined);
      expect(existsSync(join(home(), '.cache'))).to.equal(false);
    });

    it('leaves the cache off on a platform without uids', () => {
      expect(compileCacheDir({ ...host({}), uid: undefined })).to.equal(undefined);
    });
  });

  describe('on Windows', () => {
    const host = (env: NodeJS.ProcessEnv): CompileCacheHost => ({ env, platform: 'win32', homedir: home(), uid: undefined });

    it('uses spinajs/compile-cache under %LOCALAPPDATA%', () => {
      const local = join(work, 'local');
      expect(compileCacheDir(host({ LOCALAPPDATA: local }))).to.equal(join(local, 'spinajs', 'compile-cache'));
      expect(lstatSync(join(local, 'spinajs', 'compile-cache')).isDirectory()).to.equal(true);
    });

    it('falls back to AppData/Local in the home dir', () => {
      expect(compileCacheDir(host({}))).to.equal(join(home(), 'AppData', 'Local', 'spinajs', 'compile-cache'));
    });
  });

  // POSIX ownership and permission bits: Windows reports neither, its per-user dir is protected by ACLs instead.
  if (process.platform !== 'win32') {
    describe('on POSIX', () => {
      const uid = process.getuid!();
      const host = (env: NodeJS.ProcessEnv, as = uid): CompileCacheHost => ({ env, platform: 'linux', homedir: home(), uid: as });
      const cacheRoot = () => join(work, 'xdg');
      const xdg = () => ({ XDG_CACHE_HOME: cacheRoot() });

      it('creates spinajs/compile-cache under $XDG_CACHE_HOME, readable by this user only', () => {
        const dir = compileCacheDir(host(xdg()));
        expect(dir).to.equal(join(cacheRoot(), 'spinajs', 'compile-cache'));
        for (const created of [cacheRoot(), join(cacheRoot(), 'spinajs'), dir!]) expect(lstatSync(created).mode & 0o777).to.equal(0o700);
      });

      it('uses ~/.cache without $XDG_CACHE_HOME or with a relative one', () => {
        expect(compileCacheDir(host({}))).to.equal(join(home(), '.cache', 'spinajs', 'compile-cache'));
        expect(compileCacheDir(host({ XDG_CACHE_HOME: 'relative/cache' }))).to.equal(join(home(), '.cache', 'spinajs', 'compile-cache'));
      });

      it('accepts an existing cache dir others can read but not write', () => {
        mkdirSync(join(cacheRoot(), 'spinajs', 'compile-cache'), { recursive: true });
        for (const dir of [cacheRoot(), join(cacheRoot(), 'spinajs'), join(cacheRoot(), 'spinajs', 'compile-cache')]) chmodSync(dir, 0o755);
        expect(compileCacheDir(host(xdg()))).to.equal(join(cacheRoot(), 'spinajs', 'compile-cache'));
      });

      it('leaves the cache off when the cache dir is world-writable', () => {
        mkdirSync(join(cacheRoot(), 'spinajs', 'compile-cache'), { recursive: true, mode: 0o700 });
        chmodSync(join(cacheRoot(), 'spinajs', 'compile-cache'), 0o777);
        expect(compileCacheDir(host(xdg()))).to.equal(undefined);
      });

      it('leaves the cache off when a dir above it is group-writable', () => {
        mkdirSync(join(cacheRoot(), 'spinajs'), { recursive: true, mode: 0o700 });
        chmodSync(join(cacheRoot(), 'spinajs'), 0o770);
        expect(compileCacheDir(host(xdg()))).to.equal(undefined);
        expect(existsSync(join(cacheRoot(), 'spinajs', 'compile-cache'))).to.equal(false);
      });

      it('leaves the cache off when the cache root is a shared dir', () => {
        mkdirSync(cacheRoot(), { mode: 0o700 });
        chmodSync(cacheRoot(), 0o1777);
        expect(compileCacheDir(host(xdg()))).to.equal(undefined);
      });

      it('leaves the cache off when its dirs belong to another user', () => {
        mkdirSync(join(cacheRoot(), 'spinajs', 'compile-cache'), { recursive: true, mode: 0o700 });
        expect(compileCacheDir(host(xdg(), uid + 1))).to.equal(undefined);
      });

      it('leaves the cache off when the cache dir is a link', () => {
        const elsewhere = join(work, 'elsewhere');
        mkdirSync(elsewhere, { mode: 0o700 });
        mkdirSync(join(cacheRoot(), 'spinajs'), { recursive: true, mode: 0o700 });
        symlinkSync(elsewhere, join(cacheRoot(), 'spinajs', 'compile-cache'));
        expect(compileCacheDir(host(xdg()))).to.equal(undefined);
      });
    });
  }
});
