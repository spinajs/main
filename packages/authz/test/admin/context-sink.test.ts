import * as chai from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import { userPrincipal } from '@spinajs/authz-testing';

import { AuthzConfigError, AuthzEventSink, LogAuthzEventSink, adminActor, adminContainer } from '@spinajs/authz';
import type { AdminCallContext, AdminContext, AuthzEvent, AuthzService, HostLog } from '@spinajs/authz';

const expect = chai.expect;

const alice = userPrincipal('alice');

describe('admin call context', () => {
  const base: AdminContext = { domain: 'root', now: new Date(0), authz: {} as AuthzService };

  it('adminActor and adminContainer read an AdminCallContext', () => {
    const ctx: AdminCallContext = { ...base, actor: alice, container: DI.RootContainer, dryRun: false };
    expect(adminActor(ctx)).to.equal(alice);
    expect(adminContainer(ctx)).to.equal(DI.RootContainer);
  });

  it('throw AuthzConfigError for a plain AdminContext', () => {
    expect(() => adminActor(base)).to.throw(AuthzConfigError);
    expect(() => adminContainer(base)).to.throw(AuthzConfigError);
    expect(() => adminActor(undefined as unknown as AdminContext)).to.throw(AuthzConfigError);
  });
});

describe('LogAuthzEventSink', () => {
  const event = (type: string): AuthzEvent => ({ type, domain: 'root', actor: { type: 'user', id: 'alice' }, at: new Date(0), data: { id: 'a1' } });

  function recordingLog(): HostLog & { lines: string[] } {
    const lines: string[] = [];
    const push = (m: string) => lines.push(m);
    return { lines, info: push, warn: push, error: push, debug: push };
  }

  it('is registered as an AuthzEventSink', () => {
    expect(DI.RootContainer.getRegisteredTypes(Array.chainOf(AuthzEventSink))).to.include(LogAuthzEventSink);
  });

  it('logs each event at info', async () => {
    const log = recordingLog();
    await new LogAuthzEventSink(log).publish([event('RoleAssigned'), event('RoleRevoked')]);
    expect(log.lines).to.have.length(2);
    expect(log.lines[0])
      .to.match(/RoleAssigned/)
      .and.match(/domain=root/)
      .and.match(/actor=user:alice/);
  });

  it('never throws', async () => {
    const log = recordingLog();
    log.info = () => {
      throw new Error('log down');
    };
    await new LogAuthzEventSink(log).publish([event('RoleAssigned'), null as unknown as AuthzEvent]);
  });
});
