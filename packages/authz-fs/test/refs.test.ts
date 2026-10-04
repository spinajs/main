import * as chai from 'chai';
import 'mocha';

import { GLOBAL } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { InvalidArgument } from '@spinajs/exceptions';

import { fsAncestors, fsRef, normalizeFsPath, parseFsRef } from '../src/index.js';

const expect = chai.expect;

describe('authz-fs refs: normalizeFsPath', () => {
  const table: [string, string][] = [
    ['a.txt', 'a.txt'],
    ['a/b/c.pdf', 'a/b/c.pdf'],
    ['a\\b', 'a/b'],
    ['a\\b\\c.txt', 'a/b/c.txt'],
    ['./a/../b', 'b'],
    ['./a', 'a'],
    ['a//b', 'a/b'],
    ['a/./b', 'a/b'],
    ['a/b/', 'a/b'],
    ['a/b//', 'a/b'],
    ['a/..', ''],
    ['', ''],
    ['.', ''],
    ['./', ''],
    ['/', ''],
    ['\\', ''],
    ['//', ''],
    ['...', '...'],
    ['a/.hidden', 'a/.hidden'],
  ];
  for (const [input, expected] of table) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(normalizeFsPath(input)).to.equal(expected);
    });
  }

  const refused: [string, string | undefined][] = [
    ['../x', undefined],
    ['..', undefined],
    ['a/../../x', undefined],
    ['a\\..\\..\\x', undefined],
    ['a\0b', undefined],
    ['/etc/passwd', undefined],
    ['C:\\x', undefined],
    ['c:/x', undefined],
    ['C:x', undefined],
    ['\\\\server\\share\\x', undefined],
    ['/..', '/data/up'],
    ['/data/upload/x', '/data/up'],
    ['/data/up/../other/x', '/data/up'],
    ['/etc/passwd', '/data/up'],
    ['D:\\data\\up\\x', 'C:\\data\\up'],
    ['C:\\data\\upload\\x', 'C:\\data\\up'],
    ['/data/up/../../x', '/data/up'],
  ];
  for (const [input, base] of refused) {
    it(`refuses ${JSON.stringify(input)}${base ? ` under ${base}` : ''}`, () => {
      expect(() => normalizeFsPath(input, base)).to.throw(InvalidArgument);
    });
  }

  it('refuses a non-string path', () => {
    expect(() => normalizeFsPath(undefined as unknown as string)).to.throw(InvalidArgument);
    expect(() => normalizeFsPath(7 as unknown as string)).to.throw(InvalidArgument);
  });

  const inside: [string, string, string][] = [
    ['/data/up/a/b.txt', '/data/up', 'a/b.txt'],
    ['/data/up/a/b.txt', '/data/up/', 'a/b.txt'],
    ['/data/up', '/data/up', ''],
    ['/data/up/', '/data/up', ''],
    ['/data/up/a/../b', '/data/up', 'b'],
    ['C:\\data\\up\\a\\b.txt', 'C:\\data\\up', 'a/b.txt'],
    ['c:/data/up/a.txt', 'C:\\data\\up', 'a.txt'],
    ['C:\\Data\\Up\\a.txt', 'c:\\data\\up', 'a.txt'],
    ['C:\\data\\up', 'C:\\data\\up\\', ''],
    ['relative/x', '/data/up', 'relative/x'],
    ['/', '/data/up', ''],
  ];
  for (const [input, base, expected] of inside) {
    it(`${JSON.stringify(input)} under ${JSON.stringify(base)} -> ${JSON.stringify(expected)}`, () => {
      expect(normalizeFsPath(input, base)).to.equal(expected);
    });
  }

  it('compares posix base paths case-sensitively', () => {
    expect(() => normalizeFsPath('/Data/up/a.txt', '/data/up')).to.throw(InvalidArgument);
  });

  it('is idempotent', () => {
    for (const p of ['a/b', 'a\\b\\', './x/../y/z', '']) {
      const once = normalizeFsPath(p);
      expect(normalizeFsPath(once)).to.equal(once);
    }
  });
});

describe('authz-fs refs: fsRef and parseFsRef', () => {
  it('builds file and dir refs with a normalised id', () => {
    expect(fsRef('uploads', 'a\\b\\c.pdf', 'file')).to.deep.equal({ type: 'file', id: 'uploads:a/b/c.pdf' });
    expect(fsRef('uploads', './docs/', 'dir')).to.deep.equal({ type: 'dir', id: 'uploads:docs' });
  });

  it('builds the fs ref for every root form, whatever the kind', () => {
    for (const root of ['', '.', './', '/', 'a/..']) {
      expect(fsRef('uploads', root, 'file')).to.deep.equal({ type: 'fs', id: 'uploads' });
      expect(fsRef('uploads', root, 'dir')).to.deep.equal({ type: 'fs', id: 'uploads' });
    }
  });

  it('keeps - and _ in fs names', () => {
    expect(fsRef('fs-temp', 'x', 'file')).to.deep.equal({ type: 'file', id: 'fs-temp:x' });
    expect(fsRef('__file_upload_default_provider__', 'a/b', 'dir')).to.deep.equal({ type: 'dir', id: '__file_upload_default_provider__:a/b' });
  });

  it('refuses a bad fs name or path', () => {
    expect(() => fsRef('', 'x', 'file')).to.throw(InvalidArgument);
    expect(() => fsRef('a:b', 'x', 'file')).to.throw(InvalidArgument);
    expect(() => fsRef('uploads', '../x', 'file')).to.throw(InvalidArgument);
    expect(() => fsRef('uploads', 'x', 'other' as 'file')).to.throw(InvalidArgument);
  });

  it('round-trips through parseFsRef', () => {
    const cases: [string, string, 'file' | 'dir'][] = [
      ['uploads', 'a/b/c.pdf', 'file'],
      ['uploads', 'a', 'dir'],
      ['fs-temp', 'notes/x:y.txt', 'file'],
      ['fs-temp', 'ab:c.txt', 'file'],
      ['__file_upload_default_provider__', 'tmp/1', 'file'],
      ['uploads', '', 'dir'],
    ];
    for (const [fsName, path, kind] of cases) {
      const ref = fsRef(fsName, path, kind);
      expect(parseFsRef(ref), `${fsName}:${path}`).to.deep.equal({ fs: fsName, path, type: path === '' ? 'fs' : kind });
    }
  });

  it('splits the id at the first colon', () => {
    expect(parseFsRef({ type: 'file', id: 'uploads:ab:c/d' })).to.deep.equal({ fs: 'uploads', path: 'ab:c/d', type: 'file' });
    expect(parseFsRef({ type: 'file', id: 'uploads:a:b' }), 'a drive-like path is absolute').to.equal(undefined);
  });

  it('gives undefined for a foreign or malformed ref', () => {
    const foreign: ResourceRef[] = [
      GLOBAL,
      { type: 'task', id: '42' },
      { type: 'file' },
      { type: 'fs' },
      { type: 'fs', id: '' },
      { type: 'fs', id: 'a:b' },
      { type: 'file', id: 'nocolon' },
      { type: 'file', id: ':a' },
      { type: 'file', id: 'uploads:' },
      { type: 'dir', id: 'uploads:a/../b' },
      { type: 'file', id: 'uploads:a/' },
      { type: 'file', id: 'uploads:a\\b' },
      { type: 'file', id: 'uploads:../x' },
    ];
    for (const ref of foreign) expect(parseFsRef(ref), JSON.stringify(ref)).to.equal(undefined);
  });
});

describe('authz-fs refs: fsAncestors', () => {
  const task: ResourceRef = { type: 'task', id: '42' };
  const project: ResourceRef = { type: 'project', id: 'p1' };

  it('orders a file: self, parent dirs nearest first, fs, resolver parents, GLOBAL', () => {
    expect(fsAncestors({ type: 'file', id: 'uploads:a/b/c.pdf' }, [task, project])).to.deep.equal([
      { type: 'file', id: 'uploads:a/b/c.pdf' },
      { type: 'dir', id: 'uploads:a/b' },
      { type: 'dir', id: 'uploads:a' },
      { type: 'fs', id: 'uploads' },
      task,
      project,
      GLOBAL,
    ]);
  });

  it('orders a dir', () => {
    expect(fsAncestors({ type: 'dir', id: 'uploads:a/b' })).to.deep.equal([{ type: 'dir', id: 'uploads:a/b' }, { type: 'dir', id: 'uploads:a' }, { type: 'fs', id: 'uploads' }, GLOBAL]);
  });

  it('orders a top-level file', () => {
    expect(fsAncestors({ type: 'file', id: 'uploads:x.txt' })).to.deep.equal([{ type: 'file', id: 'uploads:x.txt' }, { type: 'fs', id: 'uploads' }, GLOBAL]);
  });

  it('orders the fs root', () => {
    expect(fsAncestors({ type: 'fs', id: 'uploads' }, [task])).to.deep.equal([{ type: 'fs', id: 'uploads' }, task, GLOBAL]);
  });

  it('drops GLOBAL and repeated refs among the parents', () => {
    expect(fsAncestors({ type: 'fs', id: 'uploads' }, [task, GLOBAL, task, { type: 'fs', id: 'uploads' }])).to.deep.equal([{ type: 'fs', id: 'uploads' }, task, GLOBAL]);
  });

  it('gives null for a foreign ref', () => {
    expect(fsAncestors({ type: 'task', id: '42' })).to.equal(null);
    expect(fsAncestors({ type: 'file', id: 'uploads:a/../b' })).to.equal(null);
  });
});
