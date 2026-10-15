import 'mocha';
import { expect } from 'chai';
import { AccessDenied, AuthzAdminFailure, FALSE } from '@spinajs/authz';
import type { Decision } from '@spinajs/authz';
import { InvalidArgument, ResourceDuplicated, ResourceNotFound } from '@spinajs/exceptions';
import { InvitationRefused } from '@spinajs/teams';

// authz-http-admin's answer table; a relative import, as authz-http-admin's tests reach authz-rbac's.
import { adminErrorStatus } from '../../authz-http-admin/src/routes/status.js';
import { memberJson } from '../src/http/answers.js';
import { teamsErrorStatus, teamsFailureAnswer } from '../src/http/errors.js';
import { DEFAULT_PAGE_SIZE, definedOnly, pageOf } from '../src/http/request.js';
import { SUBJECT_PATTERN, parseUser } from '../src/http/subjects.js';

const ADMIN_CODES = ['forbidden', 'escalation', 'last_holder', 'self_lockout', 'protected_role', 'not_found', 'conflict', 'unknown_role', 'not_assignable', 'wrong_scope_type', 'unknown_ladder', 'unknown_permission', 'invalid_attributes', 'not_list_filterable', 'set_cycle', 'set_too_deep', 'invalid_request', 'invalid_batch'];

describe('teams-http helpers', () => {
  describe('teamsErrorStatus', () => {
    it('answers every AuthzAdmin code as authz-http-admin does', () => {
      for (const code of ADMIN_CODES) expect(teamsErrorStatus(code), code).to.eq(adminErrorStatus(code));
    });

    it('answers the invitation codes', () => {
      expect(teamsErrorStatus('invitation_unknown')).to.eq(404);
      for (const code of ['invitation_expired', 'invitation_revoked', 'invitation_used_up']) expect(teamsErrorStatus(code), code).to.eq(409);
      for (const code of ['invitation_email_mismatch', 'invitation_not_a_user']) expect(teamsErrorStatus(code), code).to.eq(403);
      expect(teamsErrorStatus('no_such_code')).to.eq(400);
    });
  });

  describe('teamsFailureAnswer', () => {
    it('answers AuthzAdminFailure by code with the field, and InvitationRefused as invitation_<code>', () => {
      expect(teamsFailureAnswer(new AuthzAdminFailure('last_holder', 'team:t1 keeps one team.owner', 'subject'))).to.deep.eq({ status: 403, error: { code: 'last_holder', message: 'team:t1 keeps one team.owner', field: 'subject' } });
      expect(teamsFailureAnswer(new InvitationRefused('used_up'))).to.deep.eq({ status: 409, error: { code: 'invitation_used_up', message: 'invitation refused: used_up' } });
      expect(teamsFailureAnswer(new InvitationRefused('unknown'))?.status).to.eq(404);
      expect(teamsFailureAnswer(new InvitationRefused('email_mismatch'))?.status).to.eq(403);
    });

    it('answers the @spinajs/exceptions errors the services throw', () => {
      expect(teamsFailureAnswer(new ResourceNotFound('team t1 not found'))).to.deep.eq({ status: 404, error: { code: 'not_found', message: 'team t1 not found' } });
      expect(teamsFailureAnswer(new ResourceDuplicated('slug red is taken'))).to.deep.eq({ status: 409, error: { code: 'conflict', message: 'slug red is taken' } });
      expect(teamsFailureAnswer(new InvalidArgument('the parent group is in another team', 'parentId'))).to.deep.eq({ status: 400, error: { code: 'invalid_request', message: 'the parent group is in another team', field: 'parentId' } });
    });

    it('leaves AccessDenied and unknown errors to http', () => {
      const decision = { permission: 'team:read', resource: { type: 'team', id: 't1' }, allowed: false, residual: FALSE, reason: { code: 'no_grant' } } as unknown as Decision;
      expect(teamsFailureAnswer(new AccessDenied(decision))).to.eq(undefined);
      expect(teamsFailureAnswer(new Error('boom'))).to.eq(undefined);
      expect(teamsFailureAnswer(Object.assign(new Error('db'), { code: 'SQLITE_CONSTRAINT' }))).to.eq(undefined);
    });
  });

  describe('subjects', () => {
    it('reads a user for an ownership transfer and refuses a set', () => {
      expect(parseUser('user:42', 'to')).to.deep.eq({ type: 'user', id: '42' });
      for (const bad of ['group:g1', 'user:', 'alice', 42]) expect(() => parseUser(bad, 'to'), String(bad)).to.throw(InvalidArgument, /user:<id>/).with.property('fieldName', 'to');
    });

    it('lets the body schema pass every label parseSubjectLabel reads', () => {
      const pattern = new RegExp(SUBJECT_PATTERN);
      for (const ok of ['user:42', 'group:g1', 'team:t:1', 'service:s1']) expect(pattern.test(ok), ok).to.eq(true);
      for (const bad of ['alice', 'user:', ':42']) expect(pattern.test(bad), bad).to.eq(false);
    });
  });

  describe('request and answer helpers', () => {
    it('turns page and size into a Page', () => {
      expect(pageOf()).to.deep.eq({ limit: DEFAULT_PAGE_SIZE, offset: 0 });
      expect(pageOf(2, 10)).to.deep.eq({ limit: 10, offset: 20 });
      expect(pageOf(3)).to.deep.eq({ limit: DEFAULT_PAGE_SIZE, offset: 3 * DEFAULT_PAGE_SIZE });
      expect(Object.isFrozen(pageOf())).to.eq(true);
    });

    it('drops undefined keys and keeps null', () => {
      expect(definedOnly({ a: 1, b: undefined, c: null })).to.deep.eq({ a: 1, c: null });
      expect(Object.keys(definedOnly({ a: undefined }))).to.deep.eq([]);
    });

    it('answers a member with its subject as a label', () => {
      expect(memberJson({ subject: { group: 'g1' }, role: 'team.member', assignmentId: 'a1', expiresAt: null })).to.deep.eq({ subject: 'group:g1', role: 'team.member', assignmentId: 'a1', expiresAt: null });
      expect(memberJson({ subject: { type: 'user', id: '42' }, role: 'team.owner', assignmentId: 'a2', expiresAt: null }).subject).to.eq('user:42');
    });
  });
});
