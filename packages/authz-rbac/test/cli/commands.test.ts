import { AuthzAdminFailure, GLOBAL, SYSTEM } from '@spinajs/authz';
import { expect } from 'chai';
import 'mocha';

import { AssignCommand, ExplainCommand, RevokeCommand } from '../../src/cli/index.js';
import { capture, fakeAuthz, withAuthz } from './fixture.js';
import type { Captured } from './fixture.js';

describe('authz cli commands', () => {
  let io: Captured;
  beforeEach(() => (io = capture()));
  afterEach(() => io.restore());

  describe('authz:assign', () => {
    it('sends the assignment as SYSTEM inside runAs(SYSTEM, cli) and prints the id', async () => {
      const f = fakeAuthz();
      await withAuthz(new AssignCommand(), f.service).execute('user:42', 'editor', { scope: 'project:p1', expires: '2030-01-02T03:04:05Z', tags: 'a, b' });

      expect(f.runAs).to.deep.equal([{ principal: SYSTEM, reason: 'cli' }]);
      expect(f.calls).to.have.length(1);
      const [call] = f.calls;
      expect(call.method).to.equal('assign');
      expect(call.actor).to.equal(SYSTEM);
      expect(call.insideRunAs).to.equal(true);
      expect(call.args[1]).to.deep.equal({ reason: 'cli' });
      expect(call.args[0]).to.deep.equal({ subject: { type: 'user', id: '42' }, role: 'editor', scope: { type: 'project', id: 'p1' }, tags: ['a', 'b'], expiresAt: new Date('2030-01-02T03:04:05Z') });
      expect(io.out).to.deep.equal(['asg-1']);
      expect(io.exitCode()).to.equal(undefined);
    });

    it('defaults the scope to GLOBAL and leaves tags and expiry out', async () => {
      const f = fakeAuthz();
      await withAuthz(new AssignCommand(), f.service).execute('user:42', 'viewer', {});
      expect(f.calls[0].args[0]).to.deep.equal({ subject: { type: 'user', id: '42' }, role: 'viewer', scope: GLOBAL });
    });

    for (const [name, args, message] of [
      ['a bad subject', ['nobody', 'editor', {}], 'a principal must look like'],
      ['a bad scope', ['user:1', 'editor', { scope: 'project' }], 'a resource must look like'],
      ['a bad date', ['user:1', 'editor', { expires: 'soon' }], '--expires'],
      ['a system subject', ['system:system', 'editor', {}], 'cannot hold roles'],
      ['an unattended subject', ['unattended:unattended', 'editor', {}], 'cannot hold roles'],
      ['an empty role', ['user:1', ' ', {}], 'role'],
    ] as const) {
      it(`reports ${name} with exit code 1 and no admin call`, async () => {
        const f = fakeAuthz();
        await withAuthz(new AssignCommand(), f.service).execute(...(args as unknown as [string, string, object]));
        expect(f.calls).to.have.length(0);
        expect(f.runAs).to.have.length(0);
        expect(io.err).to.have.length(1);
        expect(io.err[0]).to.contain(message);
        expect(io.exitCode()).to.equal(1);
      });
    }

    it('reports an admin failure as one line and exit code 1', async () => {
      const f = fakeAuthz();
      (f.admin as { assign: unknown }).assign = async () => {
        throw new AuthzAdminFailure('unknown_role', 'role nope is not defined');
      };
      await withAuthz(new AssignCommand(), f.service).execute('user:1', 'nope', {});
      expect(io.err).to.deep.equal(['role nope is not defined (unknown_role)']);
      expect(io.exitCode()).to.equal(1);
    });
  });

  describe('authz:revoke', () => {
    it('sends assignment.revokeWhere with the scope default GLOBAL and prints the count', async () => {
      const f = fakeAuthz();
      await withAuthz(new RevokeCommand(), f.service).execute('user:42', 'editor', {});

      const [call] = f.calls;
      expect(call.method).to.equal('execute');
      expect(call.actor).to.equal(SYSTEM);
      expect(call.insideRunAs).to.equal(true);
      expect(call.args[0]).to.deep.equal([{ kind: 'assignment.revokeWhere', subject: { type: 'user', id: '42' }, role: 'editor', scope: GLOBAL }]);
      expect(call.args[1]).to.deep.equal({ reason: 'cli' });
      expect(f.runAs).to.deep.equal([{ principal: SYSTEM, reason: 'cli' }]);
      expect(io.out).to.deep.equal(['3 assignment(s) revoked']);
    });

    it('passes the scope', async () => {
      const f = fakeAuthz();
      await withAuthz(new RevokeCommand(), f.service).execute('user:42', 'editor', { scope: 'project:p1' });
      expect((f.calls[0].args[0] as Array<{ scope: unknown }>)[0].scope).to.deep.equal({ type: 'project', id: 'p1' });
    });

    it('revokes one assignment by --id', async () => {
      const f = fakeAuthz();
      await withAuthz(new RevokeCommand(), f.service).execute(undefined, undefined, { id: 'asg-9' });
      expect(f.calls.map((c) => [c.method, c.actor, c.args, c.insideRunAs])).to.deep.equal([['revoke', SYSTEM, ['asg-9', { reason: 'cli' }], true]]);
      expect(io.out).to.deep.equal(['1 assignment revoked']);
    });

    it('reports a failed command result with exit code 1', async () => {
      const f = fakeAuthz({ commandResult: { ok: false, kind: 'assignment.revokeWhere', error: { code: 'forbidden', message: 'no' } } });
      await withAuthz(new RevokeCommand(), f.service).execute('user:42', 'editor', {});
      expect(io.err).to.deep.equal(['no (forbidden)']);
      expect(io.exitCode()).to.equal(1);
    });

    it('reports an empty result list with exit code 1', async () => {
      const f = fakeAuthz({ commandResult: 'none' });
      await withAuthz(new RevokeCommand(), f.service).execute('user:42', 'editor', {});
      expect(io.err[0]).to.contain('no result');
      expect(io.exitCode()).to.equal(1);
    });

    it('reports 0 revoked rows with exit code 1', async () => {
      const f = fakeAuthz({ commandResult: { ok: true, kind: 'assignment.revokeWhere', affected: 0 } });
      await withAuthz(new RevokeCommand(), f.service).execute('user:42', 'editor', {});
      expect(io.err[0]).to.contain('no assignment matched');
      expect(io.exitCode()).to.equal(1);
    });

    for (const [name, args, message] of [
      ['no target', [undefined, undefined, {}], 'give <subject> <role>'],
      ['a role without a subject', [undefined, 'editor', {}], 'give <subject> <role>'],
      ['--id with a subject', ['user:1', 'editor', { id: 'x' }], 'cannot be combined'],
      ['a bad subject', ['x', 'editor', {}], 'a principal must look like'],
      ['a system subject', ['system:system', 'editor', {}], 'cannot hold roles'],
      ['an empty role', ['user:1', '', {}], 'role'],
      ['an empty --id', [undefined, undefined, { id: ' ' }], '--id'],
    ] as const) {
      it(`reports ${name} with exit code 1 and no admin call`, async () => {
        const f = fakeAuthz();
        await withAuthz(new RevokeCommand(), f.service).execute(...(args as unknown as [string?, string?, object?]));
        expect(f.calls).to.have.length(0);
        expect(io.err[0]).to.contain(message);
        expect(io.exitCode()).to.equal(1);
      });
    }
  });

  describe('authz:explain', () => {
    const decision = {
      allowed: false,
      permission: 'doc:edit',
      resource: { type: 'doc', id: '7' },
      principal: { type: 'user', id: '42' },
      residual: false,
      fields: { read: [], write: [] },
      roles: { project: 'viewer' },
      reason: { code: 'role_too_low', model: 'rbac', ladder: 'project', needed: 'editor' },
      domain: 'root',
      trace: {
        domain: 'root',
        algorithm: 'deny-overrides',
        models: ['rbac'],
        votes: [{ model: 'rbac', reason: { code: 'role_too_low' }, roles: { project: 'viewer' } }],
        steps: [{ by: 'core', step: 'route', note: 'routed to rbac' }],
        durationMs: 2,
      },
    };

    it('builds a principal, defaults the resource to GLOBAL and prints decision and trace', async () => {
      const f = fakeAuthz({ decision });
      await withAuthz(new ExplainCommand(), f.service).execute('user:42', 'doc:edit', undefined, {});

      const [call] = f.calls;
      expect(call.insideRunAs).to.equal(true);
      expect(f.runAs).to.deep.equal([{ principal: SYSTEM, reason: 'cli' }]);
      expect(call.args[0]).to.deep.equal({ principal: { type: 'user', id: '42', authenticated: true, source: 'cli', attributes: {} }, permission: 'doc:edit', resource: GLOBAL });
      expect(io.out).to.deep.equal(['DENIED: user:42 doc:edit on doc:7', 'reason: role_too_low (rbac) {"ladder":"project","needed":"editor"}', 'roles: project=viewer', 'trace (domain root, deny-overrides, 2 ms), models: rbac', '  [core] route: routed to rbac', '  vote rbac: no permit: role_too_low roles {"project":"viewer"}']);
    });

    it('passes the resource and prints the raw Decision with --json', async () => {
      const f = fakeAuthz({ decision });
      await withAuthz(new ExplainCommand(), f.service).execute('user:42', 'doc:edit', 'doc:7', { json: true });
      expect((f.calls[0].args[0] as { resource: unknown }).resource).to.deep.equal({ type: 'doc', id: '7' });
      expect(JSON.parse(io.out.join('\n'))).to.deep.equal(decision);
    });

    it('reports a bad principal with exit code 1 and no call', async () => {
      const f = fakeAuthz({ decision });
      await withAuthz(new ExplainCommand(), f.service).execute('42', 'doc:edit', undefined, {});
      expect(f.calls).to.have.length(0);
      expect(io.exitCode()).to.equal(1);
    });
  });
});
