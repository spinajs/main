import { expect } from 'chai';
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { compileCacheDir, type CompileCacheHost } from '../src/compile-cache.js';

describe('compileCacheDir', () => {
  let work: string;
  const home = () => join(work, 'home');

  beforeEach(() => {
    // Every dir above a cache dir must belong to root or this user and be closed to group and others. The home dir is;
    // os.tmpdir(), the shared /tmp on Linux, is not, and neither is a checkout made under umask 002.
    work = realpathSync(mkdtempSync(join(homedir(), '.spinajs-compile-cache-test-')));
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

      it('leaves the cache off, and creates nothing, below a group-writable dir', () => {
        const shared = join(work, 'shared');
        mkdirSync(shared);
        chmodSync(shared, 0o775);
        expect(compileCacheDir(host({ XDG_CACHE_HOME: join(shared, 'cache') }))).to.equal(undefined);
        expect(existsSync(join(shared, 'cache'))).to.equal(false);
      });

      it('leaves the cache off, and creates nothing, below a shared sticky dir such as /tmp', () => {
        const shared = join(work, 'tmp');
        mkdirSync(shared);
        chmodSync(shared, 0o1777);
        expect(compileCacheDir(host({ XDG_CACHE_HOME: join(shared, 'cache') }))).to.equal(undefined);
        expect(existsSync(join(shared, 'cache'))).to.equal(false);
      });

      /**
       * A dir of another user, and the uid to run the check as. Root hands the dir to another uid; any other user runs
       * the check as a uid that is neither its own nor root, so that its own dirs are another user's.
       */
      const theirs = () => {
        const dir = join(work, 'theirs');
        mkdirSync(dir, { mode: 0o755 });
        if (uid !== 0) return { dir, as: uid + 1 };
        chownSync(dir, 4242, 4242);
        return { dir, as: uid };
      };

      it('leaves the cache off, and creates nothing, below a dir another user owns', () => {
        const { dir, as } = theirs();
        expect(compileCacheDir(host({ XDG_CACHE_HOME: join(dir, 'cache') }, as))).to.equal(undefined);
        expect(existsSync(join(dir, 'cache'))).to.equal(false);
      });

      it('leaves the cache off when a link above the cache root leads into a dir another user owns', () => {
        const { dir, as } = theirs();
        symlinkSync(dir, join(work, 'link'));
        expect(compileCacheDir(host({ XDG_CACHE_HOME: join(work, 'link', 'cache') }, as))).to.equal(undefined);
        expect(existsSync(join(dir, 'cache'))).to.equal(false);
      });

      it('resolves a link above the cache root and names the real dir, so a later swap of the link changes nothing', () => {
        mkdirSync(join(work, 'real'), { mode: 0o700 });
        symlinkSync(join(work, 'real'), join(work, 'link'));
        expect(compileCacheDir(host({ XDG_CACHE_HOME: join(work, 'link', 'cache') }))).to.equal(join(realpathSync(join(work, 'real')), 'cache', 'spinajs', 'compile-cache'));
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
