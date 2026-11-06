import { expect } from 'chai';
import 'mocha';
import { mergeFragments, validateFragment } from '../src/index.js';
import type { SqlDialectEntry } from '../src/index.js';
import { fragment, src } from './support.js';

const meta = { app: { name: 'app', version: '1.0.0', root: '.', outDir: 'lib' }, packages: [], generatedAt: '2026-11-06T00:00:00.000Z' };
const entry = (pkg: string, drivers: string[], name = 'postgresql'): SqlDialectEntry => ({
  drivers,
  profile: { name, grammar: 'PostgresQL', placeholders: 'dollar', families: { bigint: 'string' }, count: 'string', sum: { integer: 'string' }, avg: {}, predicates: 'boolean' },
  source: src(pkg),
});

describe('sqlDialects', () => {
  it('validates a fragment with a dialect', () => {
    expect(validateFragment(fragment('orm-postgres', { sqlDialects: [entry('orm-postgres', ['orm-driver-postgres'])] }))).to.deep.equal([]);
  });

  it('rejects an unknown placeholder style', () => {
    const bad = entry('p', ['d']);
    (bad.profile as { placeholders: string }).placeholders = 'colon';
    expect(validateFragment(fragment('p', { sqlDialects: [bad] }))).to.not.deep.equal([]);
  });

  it('merges dependencies first, then the app', () => {
    const merged = mergeFragments(fragment('app', { sqlDialects: [entry('app', ['my-driver'], 'custom')] }), [fragment('orm-postgres', { sqlDialects: [entry('orm-postgres', ['orm-driver-postgres'])] })], meta);
    expect(merged.sqlDialects?.map((d) => d.profile.name)).to.deep.equal(['postgresql', 'custom']);
  });

  it('omits the section when no fragment declares one', () => {
    expect(mergeFragments(fragment('app'), [], meta)).to.not.have.property('sqlDialects');
  });
});
