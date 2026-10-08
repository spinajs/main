import 'mocha';
import { expect } from 'chai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { BasePolicy } from '@spinajs/http';
import { AuthzDomains, AuthzService, ResourceAdapter } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
// registers authz-http's AuthzInputFieldFilter, which reads the AuthzHttpRoute mark
import '@spinajs/authz-http';
import { BaseSocketController } from '../src/controller.js';
import { Command, Payload, SocketController, SocketPolicy } from '../src/decorators.js';
import { SocketAccess, SocketAccessPolicy, fromPayload, socketAccessOf } from '../src/access.js';
import { SocketAccessContributor } from '../src/access-contributor.js';
import { ISocketCallStorage, ISocketControllerDescriptor, SOCKET_CONTROLLER_DESCRIPTOR } from '../src/interfaces.js';
import { ITestServer, command, errorOf, open, resultOf, startServer } from './harness.js';
import { ScriptedSocketAuthz, ScriptedSocketDomains } from './scripted-authz.js';

interface IAcpNote {
  id: string;
  owner: string;
}

const ACP_NOTES = new Map<string, IAcpNote>([
  ['n1', { id: 'n1', owner: '1' }],
  ['n2', { id: 'n2', owner: 'bob' }],
]);

export const acpLoads: ResourceRef[] = [];

/** Loads notes for `subject: 'load'`; owner '1' is the harness's alice. */
export class AcpNoteAdapter extends ResourceAdapter<IAcpNote> {
  public readonly kind = 'acp';
  public readonly types = ['note'];

  public accepts(_target: unknown): _target is IAcpNote {
    return false;
  }

  public refOf(target: IAcpNote): ResourceRef {
    return { type: 'note', id: target.id };
  }

  public async ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
    return [ref];
  }

  public async load(ref: ResourceRef): Promise<unknown | null> {
    acpLoads.push(ref);
    return ACP_NOTES.get(ref.id ?? '') ?? null;
  }
}

export class AcpAllow extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {}
}

const store = () => (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<ISocketCallStorage>).getStore();

@SocketController('acp')
@SocketAccess('note:list')
export class AccessParitySocket extends BaseSocketController {
  @Command('nothing')
  @SocketAccess('note:read', { resource: () => undefined as unknown as ResourceRef })
  public async nothing() {
    return 'unreachable';
  }

  @Command('load')
  @SocketAccess('note:read', { resource: fromPayload('id', 'note'), subject: 'load' })
  public async load() {
    return 'loaded';
  }

  @Command('residual')
  @SocketAccess('note:read', { resource: fromPayload('id', 'note') })
  public async residual() {
    return 'left to the handler';
  }

  @Command('own')
  @SocketAccess('note:read', { domain: 'tenant' })
  public async own() {
    const s = store();
    return { permission: s?.AuthzDecision?.permission ?? null, domain: s?.AuthzDecision?.domain ?? null, mark: s?.AuthzHttpRoute ?? null };
  }

  @Command('inherited')
  public async inherited() {
    const s = store();
    return { permission: s?.AuthzDecision?.permission ?? null, mark: s?.AuthzHttpRoute ?? null };
  }

  @Command('alt')
  @SocketAccess('note:write')
  @SocketPolicy(AcpAllow)
  public async alt(@Payload() note: Record<string, unknown>) {
    return { note, decision: store()?.AuthzDecision?.permission ?? null };
  }

  @Command('password')
  @SocketAccess('note:read', { unfilteredInput: 'the caller sets its own password' })
  public async password(@Payload() body: Record<string, unknown>) {
    return body;
  }

  @Command('update')
  @SocketAccess('note:update', { resource: fromPayload('id', 'note') })
  public async update(@Payload() note: Record<string, unknown>) {
    return note;
  }
}

/** Not registered: only its descriptor is read. */
export class AcpBaseSocket extends BaseSocketController {
  @Command('read')
  @SocketAccess('note:write', { unfilteredInput: 'the parent writes raw notes' })
  public async read() {
    return 'base';
  }
}

export class AcpChildSocket extends AcpBaseSocket {
  @Command('read')
  @SocketAccess('note:read')
  public override async read() {
    return 'child';
  }
}

const accessGroups = (type: object, member: string) => (Reflect.getMetadata(SOCKET_CONTROLLER_DESCRIPTOR, (type as { prototype: object }).prototype) as ISocketControllerDescriptor).Handlers.get(member)!.Policies.filter((g) => g.some((m) => m.Type === SocketAccessPolicy));

describe('@SocketAccess decides as authz-http AccessPolicy (G4)', function () {
  this.timeout(15000);

  let t: ITestServer;
  let alice: ClientSocket;

  const readChecks = () => ScriptedSocketAuthz.checks.filter((c) => c.input.permission === 'note:read');

  before(() => {
    DI.register(ScriptedSocketAuthz).as(AuthzService);
    DI.register(ScriptedSocketDomains).as(AuthzDomains);
    ScriptedSocketDomains.adapters = [AcpNoteAdapter];
  });

  after(() => {
    DI.unregister(ScriptedSocketAuthz);
    DI.unregister(ScriptedSocketDomains);
    ScriptedSocketDomains.adapters = [];
  });

  beforeEach(async () => {
    acpLoads.length = 0;
    ScriptedSocketAuthz.checks = [];
    ScriptedSocketAuthz.script = (input) => {
      if (input.permission === 'note:write') {
        return { allowed: false };
      }
      const ref = input.resource as ResourceRef | undefined;
      if (input.permission === 'note:read' && ref?.id !== undefined) {
        // owner only: a conditional allow until the row is known
        if (input.subject === undefined) {
          return { allowed: true, residual: { op: 'relation', relation: 'owner' } };
        }
        return { allowed: (input.subject as IAcpNote).owner === input.principal.id };
      }
      return { allowed: true };
    };
    t = await startServer();
    alice = await open(t, { auth: { clientId: 'acp-alice', token: 'good' } });
  });

  afterEach(async () => {
    alice.close();
    await t.close();
  });

  it('refuses a resource extractor that finds no resource with invalid_argument, without a type-level check', async () => {
    expect(errorOf(await command(alice, 'acp.nothing'))).to.include({ code: 'invalid_argument', message: 'the resource extractor of acp.nothing found no resource' });
    expect(readChecks()).to.have.length(0);
  });

  it("subject: 'load' settles a conditional allow against the row the domain's ResourceAdapter loads", async () => {
    expect(resultOf(await command(alice, 'acp.load', { id: 'n1' }))).to.equal('loaded');
    expect(acpLoads).to.deep.equal([{ type: 'note', id: 'n1' }]);
    expect(readChecks().map((c) => c.input.subject ?? null)).to.deep.equal([null, { id: 'n1', owner: '1' }]);
  });

  it("subject: 'load' denies another owner's row, and a missing row with unknown_resource", async () => {
    expect(errorOf(await command(alice, 'acp.load', { id: 'n2' })).details).to.deep.equal({ permission: 'note:read', resource: { type: 'note', id: 'n2' }, reason: { code: 'no_access', model: 'm1' } });
    expect(errorOf(await command(alice, 'acp.load', { id: 'n3' })).details).to.deep.equal({ permission: 'note:read', resource: { type: 'note', id: 'n3' }, reason: { code: 'unknown_resource' } });
  });

  it("subject: 'load' loads no row for a caller the first check denies, so its denial is the same for a missing and an existing row", async () => {
    ScriptedSocketAuthz.script = (input) => ({ allowed: input.permission !== 'note:read' });

    const existing = errorOf(await command(alice, 'acp.load', { id: 'n2' }));
    const missing = errorOf(await command(alice, 'acp.load', { id: 'n3' }));

    expect(acpLoads).to.have.length(0);
    expect(JSON.parse(JSON.stringify(missing).split('n3').join('n2'))).to.deep.equal(existing);
    expect(existing.details).to.deep.equal({ permission: 'note:read', resource: { type: 'note', id: 'n2' }, reason: { code: 'no_access', model: 'm1' } });
  });

  it("without subject: 'load' a conditional allow passes and loads no row; the residual is the handler's to apply", async () => {
    expect(resultOf(await command(alice, 'acp.residual', { id: 'n2' }))).to.equal('left to the handler');
    expect(acpLoads).to.have.length(0);
  });

  it("leaves the handler's own decision, not the class's, in the call store, with the AuthzHttpRoute mark of its domain", async () => {
    expect(resultOf(await command(alice, 'acp.own'))).to.deep.equal({ permission: 'note:read', domain: 'tenant', mark: { domain: 'tenant' } });
  });

  it("leaves the class's decision and mark for a handler without its own @SocketAccess", async () => {
    expect(resultOf(await command(alice, 'acp.inherited'))).to.deep.equal({ permission: 'note:list', mark: { domain: 'root' } });
  });

  it('keeps no decision for a call another policy group admitted, yet authz-http still strips fields.neverRead from its payload', async () => {
    expect(resultOf(await command(alice, 'acp.alt', { title: 't', Password: 'hash' }))).to.deep.equal({ note: { title: 't' }, decision: null });
  });

  it('unfilteredInput opts a command out of the input field filter, as @UnfilteredInput does', async () => {
    expect(resultOf(await command(alice, 'acp.password', { Password: 'new secret' }))).to.deep.equal({ Password: 'new secret' });
  });

  it('B02 contributes every @SocketAccess permission to the boot checks of the domain it checks in', () => {
    const ours = (domain: string) => (new SocketAccessContributor().contribute(domain).permissionRefs ?? []).filter((r) => r.source.startsWith('@SocketAccess on AccessParitySocket'));

    expect(ours('root')).to.deep.include.members([
      { permission: 'note:list', type: 'note', source: '@SocketAccess on AccessParitySocket' },
      { permission: 'note:read', source: '@SocketAccess on AccessParitySocket.load' },
      { permission: 'note:write', type: 'note', source: '@SocketAccess on AccessParitySocket.alt' },
    ]);
    expect(ours('tenant')).to.deep.equal([{ permission: 'note:read', type: 'note', source: '@SocketAccess on AccessParitySocket.own' }]);
  });
});

describe('@SocketAccess is declared once per place, as authz-http @Access (G4)', function () {
  it('refuses a second @SocketAccess on one handler or one class', () => {
    expect(() => {
      class AcpTwiceHandler extends BaseSocketController {
        @Command('x')
        @SocketAccess('note:read', { unfilteredInput: 'raw' })
        @SocketAccess('note:list')
        public async x() {}
      }
      return AcpTwiceHandler;
    }).to.throw('@SocketAccess is declared twice on AcpTwiceHandler.x');

    expect(() => {
      @SocketAccess('note:read')
      @SocketAccess('note:list')
      class AcpTwiceClass extends BaseSocketController {}
      return AcpTwiceClass;
    }).to.throw('@SocketAccess is declared twice on AcpTwiceClass');
  });

  it('refuses an unfilteredInput without a reason, as @UnfilteredInput does', () => {
    expect(() => SocketAccess('note:read', { unfilteredInput: ' ' })).to.throw('@SocketAccess unfilteredInput needs a reason');
  });

  it("replaces an inherited handler's @SocketAccess instead of keeping it as an alternative, and leaves the parent's alone", () => {
    expect(accessGroups(AcpChildSocket, 'read').map((g) => socketAccessOf([g])!.permissions)).to.deep.equal([['note:read']]);
    expect(socketAccessOf(accessGroups(AcpChildSocket, 'read'))!.unfilteredInput).to.equal(undefined);
    expect(accessGroups(AcpBaseSocket, 'read').map((g) => socketAccessOf([g])!.permissions)).to.deep.equal([['note:write']]);
  });
});

describe('authz-http reject mode on a @SocketAccess payload, AuthzDomains never resolved by the test (G4)', function () {
  this.timeout(15000);

  let t: ITestServer;
  let alice: ClientSocket;

  before(() => {
    DI.register(ScriptedSocketAuthz).as(AuthzService);
  });

  after(() => {
    DI.unregister(ScriptedSocketAuthz);
  });

  beforeEach(async () => {
    ScriptedSocketAuthz.checks = [];
    ScriptedSocketAuthz.script = () => ({ allowed: true, fields: { read: ['*'], write: ['id', 'title'] } });
    t = await startServer({ authz: { fields: { write: { mode: 'reject' } } } });
    alice = await open(t, { auth: { clientId: 'acp-alice', token: 'good' } });
  });

  afterEach(async () => {
    alice.close();
    await t.close();
  });

  it('refuses the field the decision does not let the caller write on the first call after start, instead of stripping it', async () => {
    expect(errorOf(await command(alice, 'acp.update', { id: 'n1', title: 'new', owner: 'mallory' }))).to.deep.equal({ code: 'invalid_argument', message: 'fields not writable: owner', retryable: false, details: { error: 'fields_not_writable', fields: ['owner'] } });
  });
});
