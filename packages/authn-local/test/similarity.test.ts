import 'mocha';
import { expect } from 'chai';
import type { PasswordPolicyContext } from '@spinajs/authn/contracts';

import { LocalPasswordPolicy } from '../src/policy.js';
import type { LocalPasswordPolicyOptions } from '../src/policy.js';

const CTX: PasswordPolicyContext = { login: 'margaret', email: 'maggie.smith@example.com' };

function policy(options: LocalPasswordPolicyOptions = {}): LocalPasswordPolicy {
  const p = new LocalPasswordPolicy(options);
  p.resolve();
  return p;
}

describe('LocalPasswordPolicy identifier similarity', () => {
  it('refuses a password equal to the login', async () => {
    expect(await policy().check('margaret', CTX)).to.deep.eq(['similar_to_identifier']);
  });

  it('refuses a password that contains the login, ignoring case', async () => {
    expect(await policy().check('My-MARGARET-2024', CTX)).to.deep.eq(['similar_to_identifier']);
  });

  it('refuses a password that contains the local part of the email', async () => {
    expect(await policy().check('xx-Maggie.Smith-99', CTX)).to.deep.eq(['similar_to_identifier']);
  });

  it('refuses a password within Levenshtein distance 2 of the login', async () => {
    expect(await policy().check('margerat', CTX)).to.deep.eq(['similar_to_identifier']);
    expect(await policy().check('margaret', { login: 'margarita' })).to.deep.eq(['similar_to_identifier']);
  });

  it('passes a password 3 edits away from the login', async () => {
    expect(await policy().check('morgerat', CTX)).to.deep.eq([]);
  });

  it('treats the display name like the login', async () => {
    expect(await policy().check('Hello-Margaret-1', { name: 'margaret' })).to.deep.eq(['similar_to_identifier']);
  });

  it('passes an unrelated password', async () => {
    expect(await policy().check('Tulip-Harbour-81', CTX)).to.deep.eq([]);
  });

  it('skips the rule without a context', async () => {
    expect(await policy().check('margaret')).to.deep.eq([]);
    expect(await policy().check('margaret', {})).to.deep.eq([]);
  });

  it('does not match an identifier shorter than three characters inside a password', async () => {
    expect(await policy().check('Totally-Fine-1', { login: 'al', email: 'to@example.com' })).to.deep.eq([]);
  });

  it('is off with similarity false', async () => {
    expect(await policy({ similarity: false }).check('margaret', CTX)).to.deep.eq([]);
  });

  it('reports the refusal after the length and rule violations', async () => {
    const p = policy({ minLength: 12, rule: { type: 'string', pattern: '[0-9]' } });
    expect(await p.check('margaret', CTX)).to.deep.eq(['too_short', 'rule', 'similar_to_identifier']);
  });
});
