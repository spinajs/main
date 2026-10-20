import { expect } from 'chai';
import 'mocha';
import { GLOBAL } from '@spinajs/authz';

import { subjectKeyOf } from '../../src/index.js';

describe('subjectKeyOf', () => {
  it('is the core principal key for a principal, `type:*` for a wildcard', () => {
    expect(subjectKeyOf({ type: 'user', id: '42' })).to.eq('user:42');
    expect(subjectKeyOf({ type: 'user', id: '*' })).to.eq('user:*');
    expect(subjectKeyOf({ type: 'a:b%', id: '1' })).to.eq('a%3Ab%25:1');
  });

  it('is `type:id#role` for a subject set, GLOBAL and type-level scopes with an empty id', () => {
    expect(subjectKeyOf({ set: { role: 'member', scope: { type: 'team', id: '7' } } })).to.eq('team:7#member');
    expect(subjectKeyOf({ set: { role: 'admins', scope: GLOBAL } })).to.eq('$global:#admins');
    expect(subjectKeyOf({ set: { role: 'member', scope: { type: 'team' } } })).to.eq('team:#member');
  });

  it('escapes %, # and * in the id of a principal, so no principal key equals a set key or the wildcard', () => {
    expect(subjectKeyOf({ type: 'team', id: '7#member' })).to.eq('team:7%23member');
    expect(subjectKeyOf({ type: 'user', id: 'a*' })).to.eq('user:a%2A');
    expect(subjectKeyOf({ type: 'user', id: '**' })).to.eq('user:%2A%2A');
    expect(subjectKeyOf({ type: 'user', id: '50%' })).to.eq('user:50%25');
    expect(subjectKeyOf({ type: 'user', id: '%23' })).to.eq('user:%2523');
  });

  it('escapes %, # and * in the id of a set scope; the role follows the first #', () => {
    expect(subjectKeyOf({ set: { role: 'member', scope: { type: 'team', id: 'a#b' } } })).to.eq('team:a%23b#member');
    expect(subjectKeyOf({ set: { role: 'member', scope: { type: 'team', id: '*' } } })).to.eq('team:%2A#member');
    expect(subjectKeyOf({ set: { role: 'm#x', scope: { type: 'team', id: '1%' } } })).to.eq('team:1%25#m#x');
  });
});
