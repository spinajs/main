import * as chai from 'chai';
import 'mocha';
import { Container, DI } from '@spinajs/di';
import { renderTemplate } from '@spinajs/log-common';
import { userPrincipal } from '@spinajs/authz-testing';

import { AuthzAdminFailure, AuthzConfigError, AuthzEventSink, GLOBAL, LogAuthzEventSink, adminActor, adminContainer, optionalAdminService, readExpiry, readId, readNode, readPrincipal, readRef, readScope, requireAdminService } from '@spinajs/authz';
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

  describe('admin services', () => {
    class Store {}
    let container: Container;
    let ctx: AdminCallContext;
    beforeEach(() => {
      container = new Container();
      ctx = { ...base, actor: alice, container, dryRun: false };
    });

    it('resolve a registered service from the admin container', async () => {
      container.register(Store).asSelf();
      expect(await requireAdminService(ctx, Store, 'the test')).to.be.instanceOf(Store);
      expect(await optionalAdminService(ctx, Store)).to.be.instanceOf(Store);
    });

    it('without one: requireAdminService names the domain, the token and who needs it; optionalAdminService gives undefined', async () => {
      const err = await requireAdminService(ctx, Store, 'the test').then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).to.be.instanceOf(AuthzConfigError);
      expect((err as Error).message).to.contain('"root"').and.contain('Store').and.contain('the test');
      expect(await optionalAdminService(ctx, Store)).to.equal(undefined);
    });
  });
});

describe('admin command field readers', () => {
  const refused = (read: () => unknown, field: string): void => {
    let err: unknown;
    try {
      read();
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(AuthzAdminFailure);
    expect((err as AuthzAdminFailure).code).to.equal('invalid_command');
    expect((err as AuthzAdminFailure).field).to.equal(field);
  };

  it('readId takes a non-empty string', () => {
    expect(readId('a1')).to.equal('a1');
    refused(() => readId(''), 'id');
    refused(() => readId(3, 'role'), 'role');
  });

  it('readRef copies a ref, without an id key when it has none', () => {
    const ref = readRef({ type: 'doc', id: '7', extra: 1 }, 'scope');
    expect(ref).to.deep.equal({ type: 'doc', id: '7' });
    expect(Object.keys(readRef({ type: 'doc', id: null }, 'scope'))).to.deep.equal(['type']);
    refused(() => readRef({ type: '' }, 'scope'), 'scope');
    refused(() => readRef([], 'scope'), 'scope');
    refused(() => readRef({ type: 'doc', id: '' }, 'scope'), 'scope');
  });

  it('readScope takes GLOBAL or one node', () => {
    expect(readScope({ type: GLOBAL.type, id: 'x' }, 'scope')).to.deep.equal({ type: GLOBAL.type });
    expect(readScope({ type: 'doc', id: '7' }, 'scope')).to.deep.equal({ type: 'doc', id: '7' });
    refused(() => readScope({ type: 'doc' }, 'scope'), 'scope');
    refused(() => readScope({ type: 'doc', id: '*' }, 'scope'), 'scope');
  });

  it('readNode refuses GLOBAL and a type-level ref', () => {
    expect(readNode({ type: 'doc', id: '7' }, 'node')).to.deep.equal({ type: 'doc', id: '7' });
    refused(() => readNode(GLOBAL, 'node'), 'node');
    refused(() => readNode({ type: 'doc' }, 'node'), 'node');
  });

  it('readPrincipal copies { type, id } and refuses a wildcard type', () => {
    expect(readPrincipal({ type: 'user', id: '*', roles: ['x'] }, 'subject')).to.deep.equal({ type: 'user', id: '*' });
    refused(() => readPrincipal({ type: '*', id: '*' }, 'subject'), 'subject');
    refused(() => readPrincipal({ type: 'user' }, 'subject'), 'subject');
  });

  it('readExpiry passes undefined and null and copies a valid Date', () => {
    const at = new Date(1000);
    expect(readExpiry(undefined)).to.equal(undefined);
    expect(readExpiry(null)).to.equal(null);
    const copy = readExpiry(at);
    expect(copy).to.deep.equal(at);
    expect(copy).to.not.equal(at);
    refused(() => readExpiry(new Date(NaN)), 'expiresAt');
    refused(() => readExpiry('2030-01-01', 'until'), 'until');
  });
});

describe('LogAuthzEventSink', () => {
  const event = (type: string): AuthzEvent => ({ type, domain: 'root', actor: { type: 'user', id: 'alice' }, at: new Date(0), data: { id: 'a1' } });

  function recordingLog(): HostLog & { lines: string[] } {
    const lines: string[] = [];
    const push = (fields: unknown, template?: unknown) => void lines.push(typeof fields === 'string' ? fields : renderTemplate(template as string, fields as Record<string, unknown>));
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
