import * as chai from 'chai';
import 'mocha';

import { GLOBAL } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { InvalidArgument } from '@spinajs/exceptions';

import { fsAncestors, fsRef, normalizeFsPath, parseFsRef } from '../src/index.js';

const expect = chai.expect;

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
  ['a/.hidden', 'a/.hidden'],
  ['.config/x', '.config/x'],
  ['a b/c d.txt', 'a b/c d.txt'],
  ['SECRE~1/a.txt', 'SECRE~1/a.txt'],
  ['ab:c/../x', 'x'],
];

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
  ['\\\\server\\share\\up\\a.txt', '\\\\server\\share\\up', 'a.txt'],
  ['\\\\Server\\Share\\a.txt', '\\\\server\\share', 'a.txt'],
];

// As fsNative.resolvePath: a rooted path without a drive that is not inside the base path starts at the fs root.
const rooted: [string, string | undefined, string][] = [
  ['/etc/passwd', undefined, 'etc/passwd'],
  ['\\x\\y', undefined, 'x/y'],
  ['/a/b/', undefined, 'a/b'],
  ['///x', undefined, 'x'],
  ['/etc/passwd', '/data/up', 'etc/passwd'],
  ['/data/upload/x', '/data/up', 'data/upload/x'],
  ['/data/up/../other/x', '/data/up', 'data/other/x'],
  ['/data/up/../../x', '/data/up', 'x'],
  ['/x', 'C:\\data\\up', 'x'],
  // A driveless rooted path never matches a drive base, though fsNative on the current drive would read the base.
  ['\\data\\up\\x', 'C:\\data\\up', 'data/up/x'],
  ['/data/up/x', '\\\\server\\share', 'data/up/x'],
];

const accepted: [string, string | undefined, string][] = [...table.map(([input, out]): [string, undefined, string] => [input, undefined, out]), ...inside, ...rooted];

describe('authz-fs refs: normalizeFsPath', () => {
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
    ['C:\\x', undefined],
    ['c:/x', undefined],
    ['C:x', undefined],
    ['\\\\server\\share\\x', undefined],
    ['/..', undefined],
    ['/..', '/data/up'],
    ['/a/../../x', '/data/up'],
    ['D:\\data\\up\\x', 'C:\\data\\up'],
    ['C:\\data\\upload\\x', 'C:\\data\\up'],
    ['C:\\x', '/data/up'],
    ['\\\\server\\share\\x', '/data/up'],
    ['\\\\server\\other\\x', '\\\\server\\share'],
    // a drive surfacing after normalisation
    ['./C:/x', undefined],
    ['a/../C:/x', undefined],
    ['.\\D:\\secret', undefined],
    ['x/../C:', undefined],
    ['/C:/x', undefined],
    ['/C:/x', '/data'],
    ['/data/up/c:x', '/data/up'],
    ['C:\\data\\up\\c:x', 'C:\\data\\up'],
    // a ':' anywhere in a segment, NTFS streams
    ['ab:c.txt', undefined],
    ['notes/x:y.txt', undefined],
    ['secret/a.txt::$DATA', undefined],
    ['secret/a.txt:$DATA', undefined],
    // Win32 strips a trailing dot or space
    ['secret./a.txt', undefined],
    ['secret /a.txt', undefined],
    ['secret/a.txt.', undefined],
    ['secret/a.txt ', undefined],
    ['...', undefined],
    ['/data/up/secret./a.txt', '/data/up'],
  ];
  for (const [input, base] of refused) {
    it(`refuses ${JSON.stringify(input)}${base ? ` under ${base}` : ''}`, () => {
      expect(() => normalizeFsPath(input, base)).to.throw(InvalidArgument);
    });
  }

  it('refuses a non-string path or base path', () => {
    expect(() => normalizeFsPath(undefined as unknown as string)).to.throw(InvalidArgument);
    expect(() => normalizeFsPath(7 as unknown as string)).to.throw(InvalidArgument);
    expect(() => normalizeFsPath('/x', 5 as unknown as string))
      .to.throw(InvalidArgument)
      .with.property('message')
      .that.includes('base path');
  });

  it('names the base path when the base path climbs above its root', () => {
    expect(() => normalizeFsPath('/b/x', '/a/../../b'))
      .to.throw(InvalidArgument)
      .with.property('message')
      .that.includes('base path "/a/../../b"');
  });

  for (const [input, base, expected] of inside) {
    it(`${JSON.stringify(input)} under ${JSON.stringify(base)} -> ${JSON.stringify(expected)}`, () => {
      expect(normalizeFsPath(input, base)).to.equal(expected);
    });
  }

  for (const [input, base, expected] of rooted) {
    it(`rooted ${JSON.stringify(input)}${base ? ` under ${JSON.stringify(base)}` : ''} -> ${JSON.stringify(expected)}`, () => {
      expect(normalizeFsPath(input, base)).to.equal(expected);
    });
  }

  it('compares posix base paths case-sensitively', () => {
    expect(normalizeFsPath('/Data/up/a.txt', '/data/up')).to.equal('Data/up/a.txt');
  });

  it('is idempotent on every accepted input', () => {
    for (const [input, base] of accepted) {
      const once = normalizeFsPath(input, base);
      expect(normalizeFsPath(once), `${JSON.stringify(input)} under ${base}`).to.equal(once);
      expect(normalizeFsPath(once, base), `${JSON.stringify(input)} under ${base}`).to.equal(once);
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
    expect(() => fsRef('uploads', './C:/x', 'file')).to.throw(InvalidArgument);
    expect(() => fsRef('uploads', 'x', 'other' as 'file')).to.throw(InvalidArgument);
  });

  it('round-trips every accepted input through parseFsRef', () => {
    for (const fsName of ['uploads', 'fs-temp', '__file_upload_default_provider__']) {
      for (const [input, base] of accepted) {
        const path = normalizeFsPath(input, base);
        for (const kind of ['file', 'dir'] as const) {
          expect(parseFsRef(fsRef(fsName, path, kind)), `${fsName} ${JSON.stringify(input)} ${kind}`).to.deep.equal({ fs: fsName, path, type: path === '' ? 'fs' : kind });
        }
      }
    }
  });

  it('refuses an id whose path holds a colon', () => {
    expect(parseFsRef({ type: 'file', id: 'uploads:ab:c/d' })).to.equal(undefined);
    expect(parseFsRef({ type: 'file', id: 'uploads:a:b' })).to.equal(undefined);
    expect(parseFsRef({ type: 'file', id: 'uploads:C:/x' })).to.equal(undefined);
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
      { type: 'dir', id: 'uploads:secret.' },
    ];
    for (const ref of foreign) expect(parseFsRef(ref), JSON.stringify(ref)).to.equal(undefined);
  });
});

describe('authz-fs refs: fsAncestors', () => {
  it('orders a file: self, parent dirs nearest first, fs, GLOBAL', () => {
    expect(fsAncestors({ type: 'file', id: 'uploads:a/b/c.pdf' })).to.deep.equal([
      { type: 'file', id: 'uploads:a/b/c.pdf' },
      { type: 'dir', id: 'uploads:a/b' },
      { type: 'dir', id: 'uploads:a' },
      { type: 'fs', id: 'uploads' },
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
    expect(fsAncestors({ type: 'fs', id: 'uploads' })).to.deep.equal([{ type: 'fs', id: 'uploads' }, GLOBAL]);
  });

  it("keeps the tree rule: a parent's chain is the tail of its child's", () => {
    const chain = fsAncestors({ type: 'file', id: 'uploads:a/b/c.pdf' })!;
    for (let i = 1; i < chain.length - 1; i++) expect(fsAncestors(chain[i])).to.deep.equal(chain.slice(i));
  });

  it('gives null for a foreign ref', () => {
    expect(fsAncestors({ type: 'task', id: '42' })).to.equal(null);
    expect(fsAncestors({ type: 'file', id: 'uploads:a/../b' })).to.equal(null);
  });
});
