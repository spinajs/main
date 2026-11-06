import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import glob from 'glob';
import minimatch from 'minimatch';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileNameMatcher, listConfigFiles, matchesInAnyDir } from '../src/config-files.js';

const PATTERNS = ['!(*.*).{cjs,js}', '*.test.{cjs,js}', '!(*.*).json', '*.test.json', '*.prod.{cjs,js}', '*.dev.json', '!(*.*).js', '*.a-b_c.json', '*.eu.prod.js'];

const NAMES = [
  'a.js', 'B.js', 'b.js', '_u.js', '10.js', '9.js', 'ä.js', 'Ä.js', 'с.js', 'a b.js', 'a-b.js', 'Z.cjs', 'z.mjs', 'a.JS', 'a.d.ts', 'noext', 'js', '.js', '..js',
  'a.b.js', 'a.js.js', 'x.json', 'x.test.json', 'x.test.js', 'y.test.cjs', 'x.prod.js', 'x.prod.cjs', 'x.test.test.js', 'test.js', 'Test.js', 'a.Test.js',
  '.hidden.js', '.test.js', '.x.test.js', 'x.dev.json', 'dev.json', '.dev.json', 'x.a-b_c.json', 'x.eu.prod.js', 'eu.prod.js', 'x.test.json.js', 'a.', '.',
];

const fixGlob = (dir: string, pattern: string) => join(dir, `/**/${pattern}`).replace(/\\/g, '/');

/** Creates what this platform allows; parity is compared on whatever was created. */
function tryLink(target: string, path: string, type: 'junction' | 'file'): void {
  try {
    symlinkSync(target, path, type);
  } catch {
    // file links need privileges on Windows
  }
}

describe('config file listing', () => {
  describe('file name patterns', () => {
    for (const pattern of PATTERNS) {
      it(`${pattern} matches what minimatch matches inside glob`, () => {
        const matches = fileNameMatcher(pattern);
        expect(matches).to.be.a('function');
        expect(NAMES.filter((n) => matches!(n))).to.deep.equal(NAMES.filter((n) => minimatch(n, pattern, { nonegate: true })));
      });
    }

    it('leaves every other pattern to glob', () => {
      for (const pattern of ['*.+(json)', '*.{js}', '**/*.js', '*.js', '!(*.*).{js,c?s}', '*.[ab].js', '*.{1..3}.js', 'a.js']) {
        expect(fileNameMatcher(pattern), pattern).to.equal(undefined);
      }
    });

    it('matches a relative path in any directory as minimatch does', () => {
      const paths = ['a.js', 'sub/a.js', 'sub/deep/x.test.js', '.dot/a.js', 'sub/.dot/a.js', './a.js', '../a.js', 'a/../b.js', '/a.js', 'a//b.js', 'sub/', '', 'sub\\a.js', 'dir.js/a.js', 'a.b/c.js'];
      for (const pattern of [...PATTERNS, '*.+(json)']) {
        for (const path of [...paths, ...NAMES]) {
          expect(matchesInAnyDir(path, pattern), `${path} ~ ${pattern}`).to.equal(minimatch(path, `**/${pattern}`));
        }
      }
    });
  });

  describe('listing', () => {
    let root: string;
    let dir: string;
    let outside: string;

    before(() => {
      root = realpathSync(mkdtempSync(join(tmpdir(), 'spinajs-config-files-')));
      dir = join(root, 'config');
      outside = join(root, 'outside');
      const files = [...NAMES.filter((n) => n !== '.' && n !== 'a.'), 'sub/c.js', 'sub/c.test.js', 'sub/deep/d.js', 'sub/deep/d.prod.cjs', '.dot/e.js', 'dir.js/f.js', 'sub.test.js/g.js', 'node_modules/h.js', 'UPPER/H.JSON', 'UPPER/h.json', 'a.b/i.js'];
      for (const file of files) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), '');
      }
      mkdirSync(join(dir, 'empty'));
      for (const file of ['l.js', 'l.test.json', 'nested/n.js', 'nested/deeper/m.js']) {
        mkdirSync(dirname(join(outside, file)), { recursive: true });
        writeFileSync(join(outside, file), '');
      }
      tryLink(outside, join(dir, 'linked'), 'junction');
      tryLink(outside, join(dir, 'sub', 'linked.js'), 'junction');
      tryLink(join(outside, 'nested'), join(dir, 'sub', 'deep', 'nested-link'), 'junction');
      tryLink(join(root, 'missing'), join(dir, 'broken'), 'junction');
      tryLink(join(outside, 'l.js'), join(dir, 'file-link.js'), 'file');
      writeFileSync(join(root, 'not-a-dir'), '');
    });

    after(() => rmSync(root, { recursive: true, force: true }));
    afterEach(() => sinon.restore());

    const dirs = () => [dir, join(dir, 'sub'), join(dir, 'linked'), join(root, 'missing'), join(root, 'not-a-dir'), join(dir, 'empty'), outside];

    for (const pattern of PATTERNS) {
      it(`lists ${pattern} as glob does: same paths, same order`, () => {
        for (const d of dirs()) {
          const globbed = glob.sync(fixGlob(d, pattern));
          expect(listConfigFiles(fixGlob(d, pattern)), d).to.deep.equal(globbed);
        }
      });
    }

    it('lists something in each case the parity is checked on', () => {
      const slashed = dir.replace(/\\/g, '/');
      expect(listConfigFiles(fixGlob(dir, '!(*.*).{cjs,js}'))).to.include.members([`${slashed}/sub/deep/d.js`, `${slashed}/dir.js`, `${slashed}/node_modules/h.js`]);
      expect(listConfigFiles(fixGlob(dir, '*.test.{cjs,js}')).length).to.be.greaterThan(2);
    });

    it('does not run glob for a file-source pattern over a plain directory', () => {
      const spy = sinon.spy(glob, 'sync');
      for (const pattern of PATTERNS) listConfigFiles(fixGlob(dir, pattern));
      expect(spy.called).to.equal(false);
    });

    it('hands any other pattern, and a directory with glob syntax, to glob', () => {
      const spy = sinon.spy(glob, 'sync');
      expect(listConfigFiles(fixGlob(dir, '*.+(json)'))).to.deep.equal(glob.sync(fixGlob(dir, '*.+(json)')));
      mkdirSync(join(root, '[x]', 'config'), { recursive: true });
      writeFileSync(join(root, '[x]', 'config', 'a.js'), '');
      expect(listConfigFiles(fixGlob(join(root, '[x]', 'config'), '!(*.*).js'))).to.deep.equal(glob.sync(fixGlob(join(root, '[x]', 'config'), '!(*.*).js')));
      expect(listConfigFiles(fixGlob(join(root, '[x]'), '!(*.*).js'))).to.deep.equal([]);
      expect(spy.callCount).to.equal(5);
    });
  });
});
