import { expect } from 'chai';
import 'mocha';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownEntries } from '../src/index.js';
import type { Manifest, MountedBy } from '../src/index.js';

interface Entry {
  name: string;
  mountedBy?: MountedBy;
  source: { file: string; line: number; col: number; package: string };
}

const entry = (name: string, file: string, mountedBy?: MountedBy): Entry => ({ name, ...(mountedBy ? { mountedBy } : {}), source: { file, line: 1, col: 1, package: 'app' } });

describe('ownEntries', () => {
  let root: string;
  let manifest: Manifest;

  const live = entry('live', 'src/controllers/x.ts');
  const copy = entry('copy', 'src/controllers-old/x.ts', 'di');
  const copy2 = entry('copy2', 'src/other/x.ts', 'di');
  const names = (entries: Entry[]): string[] => entries.map((e) => e.name);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'spinajs-own-entries-'));
    for (const dir of ['controllers', 'controllers-old', 'other']) {
      mkdirSync(join(root, 'lib', dir), { recursive: true });
      writeFileSync(join(root, 'lib', dir, 'x.js'), '');
    }
    manifest = { app: { name: 'app', version: '1.0.0', root, outDir: 'lib' }, packages: [] } as unknown as Manifest;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns a single candidate as it is, without looking at the file', () => {
    expect(names(ownEntries([copy], { file: join(root, 'lib', 'unrelated.js') }, manifest, root))).to.deep.equal(['copy']);
  });

  it('picks the entry of the class by its file, flagged or not', () => {
    expect(names(ownEntries([live, copy], { file: join(root, 'lib', 'controllers-old', 'x.js') }, manifest, root))).to.deep.equal(['copy']);
    expect(names(ownEntries([live, copy], { file: join(root, 'lib', 'controllers', 'x.js') }, manifest, root))).to.deep.equal(['live']);
  });

  it('tells two flagged copies apart by file', () => {
    expect(names(ownEntries([copy, copy2], { file: join(root, 'lib', 'other', 'x.js') }, manifest, root))).to.deep.equal(['copy2']);
  });

  it('takes the source file for a process run through ts-node', () => {
    expect(names(ownEntries([live, copy], { file: join(root, 'src', 'controllers', 'x.ts') }, manifest, root))).to.deep.equal(['live']);
  });

  it('reads a captured path with forward slashes', () => {
    expect(names(ownEntries([live, copy], { file: join(root, 'lib', 'controllers', 'x.js').split('\\').join('/') }, manifest, root))).to.deep.equal(['live']);
  });

  it('falls back to what the caller can match, for a class with no file', () => {
    expect(names(ownEntries([live, copy], { file: '<di>', matches: (e) => e.name === 'copy' }, manifest, root))).to.deep.equal(['copy']);
  });

  it('prefers a loaded entry over a flagged one when nothing else tells them apart', () => {
    expect(names(ownEntries([copy, live], {}, manifest, root))).to.deep.equal(['live']);
    expect(names(ownEntries([copy, live], { file: '<di>' }, manifest, root))).to.deep.equal(['live']);
  });

  it('leaves real ambiguity to the caller', () => {
    expect(names(ownEntries([copy, copy2], {}, manifest, root))).to.deep.equal(['copy', 'copy2']);
  });

  it('answers nothing when the caller matches nothing', () => {
    expect(ownEntries([live, copy], { matches: () => false }, manifest, root)).to.deep.equal([]);
  });

  it('survives an entry whose package is not installed', () => {
    const missing = { ...live, source: { ...live.source, package: 'not-installed' } };
    expect(names(ownEntries([missing, copy], { file: join(root, 'lib', 'other', 'x.js') }, manifest, root)).length).to.equal(1);
  });
});
