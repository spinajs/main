import 'mocha';
import { expect } from 'chai';
import { AccessControl } from 'accesscontrol';

import { _collectPermissions } from '../src/util.js';

/**
 * `_collectPermissions` is the shared answer to "what does this role set
 * actually permit", used both by the impersonation privilege comparison and by
 * the access-token role policies. Pure function over an AccessControl instance -
 * no container, no database.
 */
describe('_collectPermissions', () => {
  const ac = () =>
    new AccessControl({
      reader: { article: { 'read:any': ['*'] } },
      writer: { $extend: ['reader'], article: { 'update:own': ['*'] } },
      unrelated: { invoice: { 'read:own': ['*'] } },
    });

  it('returns the permissions of a role with no inheritance', () => {
    const perms = _collectPermissions(ac(), ['reader']);

    expect([...perms].sort()).to.deep.equal(['article::readAny', 'article::readOwn']);
  });

  it('includes everything reached through $extend', () => {
    const perms = _collectPermissions(ac(), ['writer']);

    expect(perms.has('article::readAny')).to.equal(true);
    expect(perms.has('article::updateOwn')).to.equal(true);
  });

  it('unions the permissions of several roles', () => {
    const perms = _collectPermissions(ac(), ['reader', 'unrelated']);

    expect(perms.has('article::readAny')).to.equal(true);
    expect(perms.has('invoice::readOwn')).to.equal(true);
  });

  it('answers with an empty set for no roles', () => {
    expect(_collectPermissions(ac(), []).size).to.equal(0);
  });

  it('ignores a role that is not in the grants map', () => {
    expect(_collectPermissions(ac(), ['nonexistent']).size).to.equal(0);
  });
});
