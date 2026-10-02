import 'mocha';
import { expect } from 'chai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Forbidden } from '@spinajs/exceptions';
import { BasePolicy } from '@spinajs/http';
import { AuthzDomains, AuthzService, FALSE, TRUE, resourceKey } from '@spinajs/authz';
import type { AccessSummary, AuthorizationModel, AuthzAdmin, CheckInput, Decision, Permission, Principal, ResourceFilter, ResourceRef } from '@spinajs/authz';
import { BaseSocketController } from '../src/controller.js';
import { Command, SocketController, SocketPolicy } from '../src/decorators.js';
import { SocketAccess, fromPayload } from '../src/access.js';
import { ISocketCallStorage } from '../src/interfaces.js';
import { ALICE_PRINCIPAL, ITestServer, command, errorOf, open, resultOf, startServer } from './harness.js';

function unused(member: string): never {
  throw new Error(`AccTestAuthz.${member} is not used by socket tests`);
}

/** `${principal id}|${permission}|${resourceKey(resource)}` */
export const accAllowed = new Set<string>();
export const accChecks: Array<{ domain: string; input: CheckInput }> = [];
/** names of the AccessSocket handlers that ran */
export const accInvoked: string[] = [];

/** A scripted AuthzService: the F4 host and the F3 engine have not merged. */
export class AccTestAuthz extends AuthzService {
  public domain = 'root';

  public async check(input: CheckInput): Promise<Decision> {
    accChecks.push({ domain: this.domain, input });
    const resource = input.resource as ResourceRef;

    if (resource.id === 'boom') {
      throw new Error('authz engine unreachable');
    }

    const allowed = accAllowed.has(`${input.principal.id}|${input.permission}|${resourceKey(resource)}`);

    return {
      allowed,
      permission: input.permission,
      resource,
      principal: { type: input.principal.type, id: input.principal.id },
      residual: allowed ? TRUE : FALSE,
      fields: { read: [], write: [] },
      roles: {},
      domain: this.domain,
      ...(allowed ? {} : { reason: { code: 'no_access', model: 'm1', priority: 400, sortKey: 'm1' } }),
    };
  }

  public current(): Principal {
    return unused('current');
  }

  public runAs<T>(): Promise<T> {
    return unused('runAs');
  }

  public can(): Promise<boolean> {
    return unused('can');
  }

  public assert(): Promise<Decision> {
    return unused('assert');
  }

  public checkMany(): Promise<ReadonlyMap<Permission, Decision>> {
    return unused('checkMany');
  }

  public filter(): Promise<ResourceFilter> {
    return unused('filter');
  }

  public filterNow(): ResourceFilter | undefined {
    return unused('filterNow');
  }

  public explain(): Promise<Decision> {
    return unused('explain');
  }

  public summary(): Promise<AccessSummary> {
    return unused('summary');
  }

  public covers(): Promise<boolean> {
    return unused('covers');
  }

  public preload(): Promise<void> {
    return unused('preload');
  }

  public invalidate(): void {
    unused('invalidate');
  }

  public models(): readonly AuthorizationModel[] {
    return unused('models');
  }

  public admin(): AuthzAdmin {
    return unused('admin');
  }
}

export class AccTestDomains extends AuthzDomains {
  public service(name: string): AuthzService {
    const service = new AccTestAuthz();
    service.domain = name;
    return service;
  }

  public create(): IContainer {
    return unused('create');
  }

  public container(): IContainer {
    return unused('container');
  }

  public names(): readonly string[] {
    return ['root', 'tenant'];
  }
}

export class AccDeny extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {
    throw new Forbidden('denied by AccDeny');
  }
}

export class AccAllow extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {}
}

const DOC = fromPayload('id', 'doc');

@SocketController('acc')
export class AccessSocket extends BaseSocketController {
  @Command('read')
  @SocketAccess('doc:read', { resource: DOC })
  public async read() {
    accInvoked.push('read');
    const store = (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<ISocketCallStorage>).getStore();
    return store?.AuthzDecision?.permission ?? null;
  }

  @Command('any')
  @SocketAccess(['doc:read', 'doc:write'], { resource: DOC })
  public async any() {
    accInvoked.push('any');
    return 'ok';
  }

  @Command('list')
  @SocketAccess('doc:list')
  public async list() {
    accInvoked.push('list');
    return 'listed';
  }

  @Command('open')
  @SocketAccess('doc:list', { allowAnonymous: true })
  public async open() {
    accInvoked.push('open');
    return 'unreachable for UNATTENDED';
  }

  @Command('also')
  @SocketAccess('doc:read', { resource: DOC, also: [AccDeny] })
  public async also() {
    accInvoked.push('also');
    return 'unreachable';
  }

  @Command('either')
  @SocketAccess('doc:read', { resource: DOC })
  @SocketPolicy(AccAllow)
  public async either() {
    accInvoked.push('either');
    return 'one path is enough';
  }

  @Command('tenant')
  @SocketAccess('doc:read', { resource: DOC, domain: 'tenant' })
  public async tenant() {
    accInvoked.push('tenant');
    return 'tenant';
  }

  @Command('nested')
  @SocketAccess('doc:read', { resource: fromPayload('doc.id', 'doc') })
  public async nested() {
    accInvoked.push('nested');
    return 'nested';
  }
}

describe('@SocketAccess', function () {
  this.timeout(15000);

  let t: ITestServer;
  let alice: ClientSocket;
  let anonymous: ClientSocket;

  const lastCheck = () => accChecks[accChecks.length - 1];

  before(() => {
    DI.register(AccTestAuthz).as(AuthzService);
    DI.register(AccTestDomains).as(AuthzDomains);
  });

  after(() => {
    DI.unregister(AccTestAuthz);
    DI.unregister(AccTestDomains);
  });

  beforeEach(async () => {
    accAllowed.clear();
    accChecks.length = 0;
    accInvoked.length = 0;
    t = await startServer();
    alice = await open(t, { auth: { clientId: 'acc-alice', token: 'good' } });
    anonymous = await open(t, { auth: { clientId: 'acc-anon' } });
  });

  afterEach(async () => {
    alice.close();
    anonymous.close();
    await t.close();
  });

  it('allows through AuthzService.check with the connection principal and the extracted resource, and leaves the decision in the call storage', async () => {
    accAllowed.add('1|doc:read|doc:d1');

    expect(resultOf(await command(alice, 'acc.read', { id: 'd1' }))).to.equal('doc:read');
    expect(lastCheck().input.principal).to.equal(ALICE_PRINCIPAL);
    expect(lastCheck().input.resource).to.deep.equal({ type: 'doc', id: 'd1' });
    expect(lastCheck().domain).to.equal('root');
  });

  it('answers a denial with forbidden and the permission, resource and reason, without priority or sortKey (B23)', async () => {
    const error = errorOf(await command(alice, 'acc.read', { id: 'd2' }));

    expect(error).to.include({ code: 'forbidden', retryable: false });
    expect(error.details).to.deep.equal({ permission: 'doc:read', resource: { type: 'doc', id: 'd2' }, reason: { code: 'no_access', model: 'm1' } });
    expect(accInvoked).to.be.empty;
  });

  it('answers unauthenticated for an UNATTENDED connection without asking the engine', async () => {
    expect(errorOf(await command(anonymous, 'acc.list')).code).to.equal('unauthenticated');
    expect(accChecks).to.have.length(0);
    expect(accInvoked).to.be.empty;
  });

  it('allowAnonymous lets an unauthenticated principal reach the engine, which decides (B09: unattended is denied)', async () => {
    expect(errorOf(await command(anonymous, 'acc.open')).code).to.equal('forbidden');
    expect(lastCheck().input.principal.type).to.equal('unattended');
    expect(accInvoked).to.be.empty;
  });

  it('denies when the engine fails, and never runs the handler', async () => {
    const error = errorOf(await command(alice, 'acc.read', { id: 'boom' }));

    expect(error.code).to.equal('internal');
    expect(accChecks).to.have.length(1);
    expect(accInvoked).to.be.empty;
  });

  it('checks several permissions as any of them', async () => {
    accAllowed.add('1|doc:write|doc:d1');
    expect(resultOf(await command(alice, 'acc.any', { id: 'd1' }))).to.equal('ok');
  });

  it("defaults the resource to the type-level ref of the permission's resource", async () => {
    accAllowed.add('1|doc:list|doc');

    expect(resultOf(await command(alice, 'acc.list'))).to.equal('listed');
    expect(lastCheck().input.resource).to.deep.equal({ type: 'doc' });
  });

  it('B23 the also policies join the access group (AND)', async () => {
    accAllowed.add('1|doc:read|doc:d1');
    expect(errorOf(await command(alice, 'acc.also', { id: 'd1' }))).to.include({ code: 'forbidden', message: 'denied by AccDeny' });
    expect(accInvoked).to.be.empty;
  });

  it('B23 a separate @SocketPolicy group stays an alternative (OR)', async () => {
    expect(resultOf(await command(alice, 'acc.either', { id: 'd9' }))).to.equal('one path is enough');
  });

  it('asks the AuthzService of the named domain', async () => {
    accAllowed.add('1|doc:read|doc:d1');

    expect(resultOf(await command(alice, 'acc.tenant', { id: 'd1' }))).to.equal('tenant');
    expect(lastCheck().domain).to.equal('tenant');
  });

  it('fromPayload reads a dotted path and refuses a call without it', async () => {
    accAllowed.add('1|doc:read|doc:d3');

    expect(resultOf(await command(alice, 'acc.nested', { doc: { id: 'd3' } }))).to.equal('nested');
    expect(errorOf(await command(alice, 'acc.nested', {}))).to.include({ code: 'invalid_argument', message: 'payload.doc.id is required' });
    expect(accInvoked).to.deep.equal(['nested']);
  });

  it('refuses a malformed permission when the decorator runs', () => {
    expect(() => SocketAccess('not a permission')).to.throw();
  });
});
