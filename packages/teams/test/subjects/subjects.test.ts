import * as chai from 'chai';
import 'mocha';

import { InvalidArgument } from '@spinajs/exceptions';

import { fromAssignmentSubject, groupSet, parseSubjectLabel, readSubject, subjectLabel, teamSet, toAssignmentSubject } from '../../src/subjects.js';

const expect = chai.expect;

describe('team subjects', () => {
  it('maps users, groups and teams to assignment subjects and back', () => {
    expect(toAssignmentSubject({ type: 'user', id: 'u1' })).to.deep.equal({ type: 'user', id: 'u1' });
    expect(toAssignmentSubject({ group: 'g1' })).to.deep.equal({ set: { role: 'group.member', scope: { type: 'group', id: 'g1' } } });
    expect(toAssignmentSubject({ team: 't1' })).to.deep.equal({ set: { role: 'team.member', scope: { type: 'team', id: 't1' } } });
    expect(fromAssignmentSubject(groupSet('g1'))).to.deep.equal({ group: 'g1' });
    expect(fromAssignmentSubject(teamSet('t1'))).to.deep.equal({ team: 't1' });
    expect(fromAssignmentSubject({ type: 'user', id: 'u1' })).to.deep.equal({ type: 'user', id: 'u1' });
    expect(fromAssignmentSubject({ set: { role: 'org.member', scope: { type: 'org', id: 'o' } } })).to.equal(undefined);
  });

  it('reads exactly one subject shape', () => {
    expect(readSubject({ group: 'g' })).to.deep.equal({ group: 'g' });
    expect(readSubject({ team: 't' })).to.deep.equal({ team: 't' });
    expect(readSubject({ type: 'user', id: 'u' })).to.deep.equal({ type: 'user', id: 'u' });
    for (const bad of [null, {}, { group: '' }, { group: 'g', team: 't' }, { type: 'user' }, { type: 'user', id: 'u', group: 'g' }]) {
      expect(() => readSubject(bad)).to.throw(InvalidArgument);
    }
  });

  it('labels subjects for URLs', () => {
    expect(subjectLabel({ type: 'user', id: '42' })).to.equal('user:42');
    expect(subjectLabel({ group: 'g' })).to.equal('group:g');
    expect(parseSubjectLabel('user:42')).to.deep.equal({ type: 'user', id: '42' });
    expect(parseSubjectLabel('group:g')).to.deep.equal({ group: 'g' });
    expect(parseSubjectLabel('team:t')).to.deep.equal({ team: 't' });
    expect(() => parseSubjectLabel('nocolon')).to.throw(InvalidArgument);
  });
});
