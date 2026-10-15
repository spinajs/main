import 'mocha';
import { expect } from 'chai';
import { AuthenticationFailed } from '@spinajs/exceptions';
import { SCHEDULER_RBAC, SCHEDULER_SSE_HEARTBEAT_MS } from '@spinajs/scheduler';

import config from '../src/config/scheduler-http.js';
import { SCHEDULER_MANAGE, SCHEDULER_READ, SCHEDULER_RESOURCE, SCHEDULER_RUN } from '../src/permissions.js';
import { triggeredByFrom } from '../src/principal.js';

describe('scheduler-http scaffold', () => {
  describe('permissions', () => {
    it('wraps the core rbac mapping as route permission lists', () => {
      expect(SCHEDULER_RESOURCE).to.eq(SCHEDULER_RBAC.resource);
      expect(SCHEDULER_READ).to.deep.equal(['readAny']);
      expect(SCHEDULER_RUN).to.deep.equal(['updateAny']);
      expect(SCHEDULER_MANAGE).to.deep.equal(['deleteAny']);
    });
  });

  describe('package configuration', () => {
    it('contributes the compiled controllers directory', () => {
      expect(config.system.dirs.controllers).to.have.lengthOf(1);
      expect(config.system.dirs.controllers[0]).to.match(/scheduler-http[\\/]lib[\\/](mjs|cjs)[\\/]controllers$/);
    });

    it('defaults the SSE heartbeat to the core constant', () => {
      expect(config.scheduler.http.sse.heartbeat).to.eq(SCHEDULER_SSE_HEARTBEAT_MS);
    });

    it('grants admins every scheduler tier through an admin sub-role', () => {
      expect(config.rbac.grants['admin.scheduler']).to.deep.equal({
        scheduler: { 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] },
      });
      expect(config.rbac.grants.admin.$extend).to.deep.equal(['admin.scheduler']);
    });
  });

  describe('triggeredByFrom', () => {
    it('describes a session user', () => {
      expect(triggeredByFrom({ User: { Uuid: 'u-1', Id: 7, Login: 'jane' } })).to.deep.equal({ kind: 'user', id: 'u-1', name: 'jane' });
    });

    it('falls back to the numeric id and the email', () => {
      expect(triggeredByFrom({ User: { Id: 7, Email: 'jane@spinajs.pl' } })).to.deep.equal({ kind: 'user', id: '7', name: 'jane@spinajs.pl' });
    });

    it('marks api-token requests as token principals', () => {
      const by = triggeredByFrom({ User: { Uuid: 'u-1', Login: 'jane' }, TokenAuth: { Uuid: 't-1' } });

      expect(by.kind).to.eq('token');
      expect(by.id).to.eq('u-1');
    });

    it('refuses to act without an authenticated user', () => {
      expect(() => triggeredByFrom({ User: null })).to.throw(AuthenticationFailed);
      expect(() => triggeredByFrom(undefined)).to.throw(AuthenticationFailed);
    });
  });
});
