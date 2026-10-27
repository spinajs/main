import 'mocha';
import { expect } from 'chai';
import { AuthenticationFailed, Forbidden } from '@spinajs/exceptions';
import { agentPrincipal, anonymousPrincipal, groupPrincipal, servicePrincipal, userPrincipal } from '@spinajs/authz-testing';
import { SCHEDULER_PERMISSIONS, SCHEDULER_SSE_HEARTBEAT_MS } from '@spinajs/scheduler';

import config from '../src/config/scheduler-http.js';
import { SCHEDULER_MANAGE, SCHEDULER_READ, SCHEDULER_RUN } from '../src/permissions.js';
import { triggeredByFrom } from '../src/principal.js';

describe('scheduler-http scaffold', () => {
  describe('permissions', () => {
    it('uses the core permission names on the routes', () => {
      expect(SCHEDULER_READ).to.eq(SCHEDULER_PERMISSIONS.read);
      expect(SCHEDULER_RUN).to.eq(SCHEDULER_PERMISSIONS.run);
      expect(SCHEDULER_MANAGE).to.eq(SCHEDULER_PERMISSIONS.manage);
    });
  });

  describe('package configuration', () => {
    it('contributes the compiled controllers directory', () => {
      expect(config.system.dirs.controllers).to.have.lengthOf(1);
      expect(config.system.dirs.controllers[0]).to.match(/scheduler-http[\\/]lib[\\/]controllers$/);
    });

    it('defaults the SSE heartbeat to the core constant', () => {
      expect(config.scheduler.http.sse.heartbeat).to.eq(SCHEDULER_SSE_HEARTBEAT_MS);
    });

    it('declares every permission the routes check', () => {
      expect(Object.keys(config.authz.permissions).sort()).to.deep.equal(Object.values(SCHEDULER_PERMISSIONS).sort());
    });

    it('grants admins every scheduler permission through an admin sub-role', () => {
      expect(config.authz.rbac.roles['admin.scheduler']).to.deep.equal({
        assignable: false,
        grants: ['scheduler:read', 'scheduler:run', 'scheduler:manage'],
      });
      expect(config.authz.rbac.roles.admin.extends).to.deep.equal(['admin.scheduler']);
    });
  });

  describe('triggeredByFrom', () => {
    it('describes a session user by its id and login', () => {
      expect(triggeredByFrom(userPrincipal('u-1', { identity: { Login: 'jane', Email: 'jane@spinajs.pl' } }))).to.deep.equal({ kind: 'user', id: 'u-1', name: 'jane' });
    });

    it('falls back to the email, and to no name', () => {
      expect(triggeredByFrom(userPrincipal('u-1', { identity: { Email: 'jane@spinajs.pl' } }))).to.deep.equal({ kind: 'user', id: 'u-1', name: 'jane@spinajs.pl' });
      expect(triggeredByFrom(userPrincipal('u-1'))).to.deep.equal({ kind: 'user', id: 'u-1' });
    });

    it('marks api-token requests as token principals', () => {
      const by = triggeredByFrom(userPrincipal('u-1', { source: 'token', identity: { Login: 'jane' } }));

      expect(by.kind).to.eq('token');
      expect(by.id).to.eq('u-1');
    });

    it('records an agent as a token of the user it acts for', () => {
      const user = userPrincipal('u-1', { identity: { Login: 'jane' } });

      expect(triggeredByFrom(agentPrincipal('a-1', user))).to.deep.equal({ kind: 'token', id: 'u-1', name: 'jane' });
    });

    it('describes a service principal', () => {
      expect(triggeredByFrom(servicePrincipal('ci'))).to.deep.equal({ kind: 'service', id: 'ci' });
    });

    it('refuses to act without an authenticated principal', () => {
      expect(() => triggeredByFrom(anonymousPrincipal())).to.throw(AuthenticationFailed);
      expect(() => triggeredByFrom(null)).to.throw(AuthenticationFailed);
      expect(() => triggeredByFrom(undefined)).to.throw(AuthenticationFailed);
    });

    it('refuses principals that cannot name who triggered the action', () => {
      expect(() => triggeredByFrom(groupPrincipal('ops'))).to.throw(Forbidden);
    });
  });
});
