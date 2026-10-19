import * as chai from 'chai';
import 'mocha';

import { InvalidArgument } from '@spinajs/exceptions';

import { normalizeFsPath } from '../src/index.js';

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

describe('fs paths: normalizeFsPath', () => {
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
      .that.includes('basePath');
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
