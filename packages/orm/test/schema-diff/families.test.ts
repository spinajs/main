import { expect } from 'chai';
import type { SqlDialectProfile } from '@spinajs/manifest';
import { familiesOf, reportsNullability } from '../../src/schema-diff/families.js';

const base: SqlDialectProfile = { name: 'test', grammar: 'Sqlite', placeholders: 'question', families: {}, count: 'number', sum: {}, avg: {}, predicates: 'number' };
const POSTGRES: SqlDialectProfile = { ...base, name: 'postgresql', nativeTypes: { varchar: ['text', 'enum'], int4: ['integer'] } };
const SQLITE: SqlDialectProfile = { ...base, name: 'sqlite', nativeTypes: { integer: ['integer', 'bigint'], text: ['text'], '': ['json'] }, untrustedNullability: ['boolean'] };

describe('schema-diff families', () => {
  it('looks a native type up in the dialect profile, ignoring case and size', () => {
    expect(familiesOf('VARCHAR(255)', POSTGRES)).to.deep.equal(['text', 'enum']);
    expect(familiesOf('int4', POSTGRES)).to.deep.equal(['integer']);
    expect(familiesOf('INTEGER', SQLITE)).to.deep.equal(['integer', 'bigint']);
    expect(familiesOf('', SQLITE)).to.deep.equal(['json']);
  });

  it('knows nothing about a type the profile does not list, or without a profile', () => {
    expect(familiesOf('citext', POSTGRES)).to.equal(undefined);
    expect(familiesOf('int', base)).to.equal(undefined);
    expect(familiesOf('int', undefined)).to.equal(undefined);
  });

  it('does not trust the nullability a profile marks as untrusted', () => {
    expect(reportsNullability(SQLITE, 'boolean')).to.equal(false);
    expect(reportsNullability(SQLITE, 'text')).to.equal(true);
    expect(reportsNullability(POSTGRES, 'boolean')).to.equal(true);
    expect(reportsNullability(undefined, 'boolean')).to.equal(true);
  });
});
