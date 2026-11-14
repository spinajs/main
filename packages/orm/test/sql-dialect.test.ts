import 'mocha';
import { expect } from 'chai';
import { SqlDialect, sqlDialectOf, type SqlDialectProfile } from '../src/index.js';

const profile: SqlDialectProfile = { name: 'x', grammar: 'MySQL', placeholders: 'question', families: {}, count: 'number', sum: {}, avg: {}, predicates: 'number' };

describe('@SqlDialect', () => {
  it('keeps the profile on the class and its subclasses', () => {
    @SqlDialect(profile)
    class Driver {}
    class SshDriver extends Driver {}
    expect(sqlDialectOf(Driver)).to.equal(profile);
    expect(sqlDialectOf(SshDriver)).to.equal(profile);
  });

  it('is undefined on an undecorated class', () => {
    expect(sqlDialectOf(class {})).to.equal(undefined);
  });
});
