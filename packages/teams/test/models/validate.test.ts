import * as chai from 'chai';
import 'mocha';

import { InvalidArgument } from '@spinajs/exceptions';

import { readDescription, readEmail, readName, readPage, readRole, readScope, readSlug } from '../../src/validate.js';

const expect = chai.expect;

describe('teams input validation', () => {
  it('reads slugs, names, descriptions, roles, emails, scopes and pages', () => {
    expect(readSlug('core-team')).to.equal('core-team');
    expect(readName('  Core  ')).to.equal('Core');
    expect(readDescription(undefined)).to.equal(null);
    expect(readDescription('x')).to.equal('x');
    expect(readRole('team.admin')).to.equal('team.admin');
    expect(readEmail(' Ann@Example.COM ')).to.equal('ann@example.com');
    expect(readScope({ type: 'team', id: 't1' })).to.deep.equal({ type: 'team', id: 't1' });
    expect(readScope({ type: '$global' })).to.deep.equal({ type: '$global' });
    expect(readPage(undefined)).to.deep.equal({ limit: 100, offset: 0 });
    expect(readPage({ limit: 5, offset: 10 })).to.deep.equal({ limit: 5, offset: 10 });
  });

  it('refuses bad values with InvalidArgument naming the field', () => {
    const field = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        expect(e).to.be.instanceOf(InvalidArgument);
        return (e as InvalidArgument).fieldName;
      }
      throw new Error('expected InvalidArgument');
    };
    expect(field(() => readSlug('Core Team'))).to.equal('slug');
    expect(field(() => readSlug('-x'))).to.equal('slug');
    expect(field(() => readSlug('x'.repeat(65)))).to.equal('slug');
    expect(field(() => readName('   '))).to.equal('name');
    expect(field(() => readName('x'.repeat(129)))).to.equal('name');
    expect(field(() => readRole('has space'))).to.equal('role');
    expect(field(() => readEmail('not-an-email'))).to.equal('email');
    expect(field(() => readScope({ type: 'team' }))).to.equal('scope');
    expect(field(() => readPage({ limit: 0, offset: 0 }))).to.equal('page');
  });
});
