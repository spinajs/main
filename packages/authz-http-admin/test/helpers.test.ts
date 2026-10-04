import 'mocha';
import { expect } from 'chai';
import { AuthzAdminFailure, GLOBAL } from '@spinajs/authz';

import { adminErrorStatus, decodeCommand, decodeCommands, parseAssignmentSubject, parseResourceRef, readAssignmentsQuery, readPageQuery, readWriteOptions, resultsStatus } from '../src/controllers/index.js';

const ISO = '2027-03-04T05:06:07.000Z';
const AT = new Date(ISO);

function failure(fn: () => unknown): AuthzAdminFailure {
  try {
    fn();
  } catch (e) {
    expect(e).to.be.instanceOf(AuthzAdminFailure);
    return e as AuthzAdminFailure;
  }
  throw new Error('expected an AuthzAdminFailure');
}

describe('JSON to command', () => {
  const dated: [string, Record<string, unknown>, (c: any) => unknown][] = [
    ['assignment.grant', { kind: 'assignment.grant', subject: { type: 'user', id: 'a' }, role: 'r', scope: GLOBAL, expiresAt: ISO }, (c) => c.expiresAt],
    ['assignment.setExpiry', { kind: 'assignment.setExpiry', id: 'x', expiresAt: ISO }, (c) => c.expiresAt],
    ['set.addMember', { kind: 'set.addMember', set: { role: 'g', scope: { type: 'group', id: 'g1' } }, member: { type: 'user', id: 'a' }, expiresAt: ISO }, (c) => c.expiresAt],
    ['link.create', { kind: 'link.create', scope: { type: 'project', id: 'p1' }, role: 'viewer', expiresAt: ISO }, (c) => c.expiresAt],
    ['link.update', { kind: 'link.update', id: 'l1', expiresAt: ISO }, (c) => c.expiresAt],
    ['rule.put', { kind: 'rule.put', rule: { id: 'r1', kind: 'restrict', expiresAt: ISO } }, (c) => c.rule.expiresAt],
    ['policy.put', { kind: 'policy.put', policy: { id: 'p1', effect: 'deny', permissions: ['a:b'], expiresAt: ISO } }, (c) => c.policy.expiresAt],
  ];

  for (const [kind, command, pick] of dated) {
    it(`turns an ISO date-time at the expiry of ${kind} into a Date`, () => {
      const out = decodeCommand(command);
      expect(pick(out)).to.be.instanceOf(Date);
      expect((pick(out) as Date).getTime()).to.equal(AT.getTime());
    });
  }

  it('accepts a time without seconds or with an offset, and keeps the instant', () => {
    expect((decodeCommand({ kind: 'link.update', id: 'l', expiresAt: '2027-03-04T07:06+02:00' }) as any).expiresAt.getTime()).to.equal(Date.parse('2027-03-04T05:06:00Z'));
  });

  it('leaves a string that is not a full ISO date-time, or does not parse, as it came', () => {
    for (const v of ['2027-03-04', '2027-03-04T05:06:07', 'tomorrow', '2027-13-45T05:06:07Z', '1700000000000', '']) {
      expect((decodeCommand({ kind: 'assignment.setExpiry', id: 'x', expiresAt: v }) as any).expiresAt).to.equal(v);
    }
  });

  it('leaves a date-time naming a day, hour or minute that does not exist as it came', () => {
    for (const v of ['2027-02-30T00:00Z', '2027-02-29T00:00Z', '2027-04-31T00:00Z', '2027-13-01T00:00Z', '2027-01-01T24:00Z', '2027-01-01T23:60Z', '2027-01-01T23:59:60Z', '2027-01-01T00:00+24:00']) {
      expect((decodeCommand({ kind: 'assignment.setExpiry', id: 'x', expiresAt: v }) as any).expiresAt, v).to.equal(v);
    }
    expect((decodeCommand({ kind: 'assignment.setExpiry', id: 'x', expiresAt: '2028-02-29T00:00Z' }) as any).expiresAt).to.be.instanceOf(Date);
  });

  it('leaves null, numbers and dates on other paths or other kinds alone', () => {
    expect(decodeCommand({ kind: 'assignment.setExpiry', id: 'x', expiresAt: null })).to.deep.equal({ kind: 'assignment.setExpiry', id: 'x', expiresAt: null });
    expect(decodeCommand({ kind: 'assignment.setExpiry', id: 'x', expiresAt: 5 })).to.deep.equal({ kind: 'assignment.setExpiry', id: 'x', expiresAt: 5 });
    expect(decodeCommand({ kind: 'scope.setAttributes', scope: GLOBAL, patch: { expiresAt: ISO } })).to.deep.equal({ kind: 'scope.setAttributes', scope: GLOBAL, patch: { expiresAt: ISO } });
    expect(decodeCommand({ kind: 'rule.put', rule: { id: 'r', when: { expiresAt: ISO } }, expiresAt: ISO })).to.deep.equal({ kind: 'rule.put', rule: { id: 'r', when: { expiresAt: ISO } }, expiresAt: ISO });
    expect(decodeCommand({ kind: 'link.create', attributes: { expiresAt: ISO } })).to.deep.equal({ kind: 'link.create', attributes: { expiresAt: ISO } });
  });

  it('never changes its input, and renames, drops or defaults nothing', () => {
    const input = { kind: 'rule.put', rule: { id: 'r1', kind: 'restrict', expiresAt: ISO, extra: 1 }, other: true };
    const snapshot = structuredClone(input);
    const out = decodeCommand(input) as any;
    expect(input).to.deep.equal(snapshot);
    expect(out).to.not.equal(input);
    expect(out.rule).to.not.equal(input.rule);
    expect({ ...out, rule: { ...out.rule, expiresAt: ISO } }).to.deep.equal(snapshot);
  });

  it('passes values that are not commands through, for AuthzAdmin to refuse', () => {
    expect(decodeCommand(null)).to.equal(null);
    expect(decodeCommand('x')).to.equal('x');
    expect(decodeCommand({ kind: 'rule.put', rule: 'x' })).to.deep.equal({ kind: 'rule.put', rule: 'x' });
    expect(decodeCommands('nope')).to.equal('nope');
    expect(decodeCommands([{ kind: 'link.update', id: 'l', expiresAt: ISO }, 7])).to.deep.equal([{ kind: 'link.update', id: 'l', expiresAt: AT }, 7]);
  });
});

describe('status mapping', () => {
  it('maps refusal codes to 403, not_found to 404, conflict to 409 and anything else to 400', () => {
    for (const code of ['forbidden', 'escalation', 'last_holder', 'self_lockout', 'protected_role']) expect(adminErrorStatus(code), code).to.equal(403);
    expect(adminErrorStatus('not_found')).to.equal(404);
    expect(adminErrorStatus('conflict')).to.equal(409);
    for (const code of ['unknown_role', 'invalid_command', 'invalid_batch', 'invalid_query', 'external_sharing_off', 'rule_not_compilable']) expect(adminErrorStatus(code), code).to.equal(400);
  });

  it('answers 200 when every result is ok, else the status of the failed result', () => {
    expect(resultsStatus([])).to.equal(200);
    expect(resultsStatus([{ ok: true, kind: 'assignment.revoke', affected: 1 }])).to.equal(200);
    expect(resultsStatus([{ ok: true, kind: 'assignment.revoke', affected: 0 }, { ok: false, kind: 'assignment.revoke', error: { code: 'not_found', message: 'x' } }])).to.equal(404);
  });
});

describe('query parsing', () => {
  it('reads a scope as <type> or <type>:<id>, split at the first colon', () => {
    expect(parseResourceRef('project', 'scope')).to.deep.equal({ type: 'project' });
    expect(parseResourceRef('project:p1', 'scope')).to.deep.equal({ type: 'project', id: 'p1' });
    expect(parseResourceRef('file:uploads:a/b.pdf', 'scope')).to.deep.equal({ type: 'file', id: 'uploads:a/b.pdf' });
    expect(parseResourceRef('$global', 'scope')).to.deep.equal(GLOBAL);
  });

  it('refuses an empty scope, type or id with invalid_query naming the field', () => {
    for (const v of ['', ':p1', 'project:']) {
      const e = failure(() => parseResourceRef(v, 'scope'));
      expect(e.code).to.equal('invalid_query');
      expect(e.field).to.equal('scope');
    }
  });

  it('reads a subject as a principal or a subject set', () => {
    expect(parseAssignmentSubject('user:alice')).to.deep.equal({ type: 'user', id: 'alice' });
    expect(parseAssignmentSubject('user:a:b')).to.deep.equal({ type: 'user', id: 'a:b' });
    expect(parseAssignmentSubject('set:group.member@group:g1')).to.deep.equal({ set: { role: 'group.member', scope: { type: 'group', id: 'g1' } } });
    expect(parseAssignmentSubject('set:org.member@org:o:1')).to.deep.equal({ set: { role: 'org.member', scope: { type: 'org', id: 'o:1' } } });
  });

  it('refuses a malformed subject', () => {
    for (const v of ['alice', 'user:', ':alice', 'set:group.member', 'set:@group:g1', 'set:group.member@', 'set:group.member@group:']) {
      const e = failure(() => parseAssignmentSubject(v));
      expect(e.code, v).to.equal('invalid_query');
      expect(e.field, v).to.equal('subject');
    }
  });

  it('builds an assignments query from the query string, with a page only when given', () => {
    expect(readAssignmentsQuery({})).to.deep.equal({ kind: 'assignments' });
    expect(readAssignmentsQuery({ scope: 'project:p1', subject: 'set:g@group:g1', role: 'viewer', includeExpired: 'true', limit: '10', offset: '20' })).to.deep.equal({
      kind: 'assignments',
      scope: { type: 'project', id: 'p1' },
      subject: { set: { role: 'g', scope: { type: 'group', id: 'g1' } } },
      role: 'viewer',
      includeExpired: true,
      page: { limit: 10, offset: 20 },
    });
    expect(readAssignmentsQuery({ includeExpired: 'false', limit: '5' })).to.deep.equal({ kind: 'assignments', includeExpired: false, page: { limit: 5 } });
  });

  it('refuses malformed values with the field they came in', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ includeExpired: 'yes' }, 'includeExpired'],
      [{ limit: 'ten' }, 'limit'],
      [{ offset: '-1' }, 'offset'],
      [{ limit: '1.5' }, 'limit'],
      [{ role: ['a', 'b'] }, 'role'],
      [{ scope: { type: 'x' } }, 'scope'],
    ];
    for (const [q, field] of cases) {
      const e = failure(() => readAssignmentsQuery(q));
      expect(e.code, JSON.stringify(q)).to.equal('invalid_query');
      expect(e.field, JSON.stringify(q)).to.equal(field);
    }
  });

  it('reads the scope and page of rules and policies', () => {
    expect(readPageQuery('rules', { scope: 'project:p1', offset: '3' })).to.deep.equal({ kind: 'rules', scope: { type: 'project', id: 'p1' }, page: { offset: 3 } });
    expect(readPageQuery('policies', {})).to.deep.equal({ kind: 'policies' });
  });

  it('reads the options of a single-command route from the query string', () => {
    expect(readWriteOptions({})).to.deep.equal({});
    expect(readWriteOptions({ reason: 'audit me', idempotencyKey: 'k1', dryRun: 'true' })).to.deep.equal({ reason: 'audit me', idempotencyKey: 'k1', dryRun: true });
    expect(readWriteOptions({ dryRun: 'false' })).to.deep.equal({ dryRun: false });
    for (const [q, field] of [
      [{ dryRun: '1' }, 'dryRun'],
      [{ reason: ['a', 'b'] }, 'reason'],
      [{ idempotencyKey: ['a', 'b'] }, 'idempotencyKey'],
    ] as [Record<string, unknown>, string][]) {
      const e = failure(() => readWriteOptions(q));
      expect(e.code).to.equal('invalid_query');
      expect(e.field).to.equal(field);
    }
  });
});
