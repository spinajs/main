import { expect } from 'chai';
import 'mocha';

import { CliUsageError, parseExpiry, parsePrincipalRef, parseResourceRef, parseSubject, parseTagList } from '../../src/cli/index.js';

describe('authz cli arguments', () => {
  it('splits type:id on the first colon', () => {
    expect(parsePrincipalRef('user:42')).to.deep.equal({ type: 'user', id: '42' });
    expect(parseResourceRef('file:a:b/c')).to.deep.equal({ type: 'file', id: 'a:b/c' });
  });

  for (const bad of ['user', ':42', 'user:', ':', '', ' : ']) {
    it(`refuses ${JSON.stringify(bad)} as a ref`, () => {
      expect(() => parsePrincipalRef(bad)).to.throw(CliUsageError, '<type>:<id>');
      expect(() => parseResourceRef(bad)).to.throw(CliUsageError);
    });
  }

  it('parses ISO 8601 expiry dates', () => {
    expect(parseExpiry('2030-01-02T03:04:05Z').toISOString()).to.equal('2030-01-02T03:04:05.000Z');
    expect(parseExpiry('2030-01-02').toISOString()).to.equal('2030-01-02T00:00:00.000Z');
  });

  it('reads an offset as the same instant', () => {
    expect(parseExpiry('2030-01-02T03:04:05+02:00').toISOString()).to.equal('2030-01-02T01:04:05.000Z');
  });

  it('refuses a day that does not exist', () => {
    expect(() => parseExpiry('2030-02-30')).to.throw(CliUsageError, 'calendar');
    expect(() => parseExpiry('2030-04-31T00:00:00Z')).to.throw(CliUsageError, 'calendar');
  });

  for (const bad of ['2030-01-02T03:04', '2030-01-02T03:04:05']) {
    it(`refuses ${JSON.stringify(bad)}: a time needs a zone`, () => {
      expect(() => parseExpiry(bad)).to.throw(CliUsageError, 'zone');
    });
  }

  it('refuses a space between date and time', () => {
    expect(() => parseExpiry('2030-01-02 03:04Z')).to.throw(CliUsageError, '--expires');
  });

  it('refuses a date in the past', () => {
    expect(() => parseExpiry('2020-01-01')).to.throw(CliUsageError, 'future');
    expect(() => parseExpiry('2030-01-01T00:00:00Z', new Date('2031-01-01T00:00:00Z'))).to.throw(CliUsageError, 'future');
  });

  it('parseSubject refuses system and unattended principals', () => {
    expect(parseSubject('user:1')).to.deep.equal({ type: 'user', id: '1' });
    expect(() => parseSubject('system:system')).to.throw(CliUsageError, 'cannot hold roles');
    expect(() => parseSubject('unattended:unattended')).to.throw(CliUsageError, 'cannot hold roles');
  });

  for (const bad of ['tomorrow', '2030-13-45', '12/31/2030', '', '1700000000']) {
    it(`refuses ${JSON.stringify(bad)} as an expiry`, () => {
      expect(() => parseExpiry(bad)).to.throw(CliUsageError, '--expires');
    });
  }

  it('trims tags and drops empties', () => {
    expect(parseTagList(' a, b ,,c,')).to.deep.equal(['a', 'b', 'c']);
    expect(parseTagList('')).to.deep.equal([]);
  });
});
