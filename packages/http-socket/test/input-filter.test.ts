import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { AuthenticationFailed, BadRequest, Forbidden } from '@spinajs/exceptions';
import { ArgInputFilter, BasePolicy } from '@spinajs/http';
import { AuthzDomains, AuthzService } from '@spinajs/authz';
// registers authz-http's AuthzInputFieldFilter as an ArgInputFilter
import '@spinajs/authz-http';
import { BaseSocketController } from '../src/controller.js';
import { Command, Payload, SocketController, SocketPolicy } from '../src/decorators.js';
import { SocketAccess, fromPayload } from '../src/access.js';
import { ITestServer, command, errorOf, open, resultOf, startServer } from './harness.js';
import { ScriptedSocketAuthz } from './scripted-authz.js';

let infWrite: readonly string[] = ['*'];

/** Refuses an `owner` key the way authz-http refuses a write in `reject` mode. */
export class InfRejectOwner extends ArgInputFilter {
  public filter(input: unknown): unknown {
    if (input !== null && typeof input === 'object' && 'owner' in input) {
      throw Object.assign(new BadRequest('fields not writable: owner'), { error: 'fields_not_writable', fields: ['owner'] });
    }
    return input;
  }
}

export class InfNeedsSession extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {
    throw Object.assign(new Forbidden('this route needs a session, not a per-request credential'), { error: 'session_required' });
  }
}

export class InfNeedsCaller extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {
    throw Object.assign(new AuthenticationFailed('this route needs an authenticated caller'), { error: 'unauthenticated' });
  }
}

@SocketController('inf')
export class InputFilterSocket extends BaseSocketController {
  @Command('update')
  @SocketAccess('doc:update', { resource: fromPayload('id', 'doc') })
  public async update(@Payload() doc: Record<string, unknown>) {
    return doc;
  }

  @Command('title')
  @SocketAccess('doc:update')
  public async title(@Payload() title: string) {
    return title;
  }

  @Command('open')
  public async open(@Payload() body: Record<string, unknown>) {
    return body;
  }

  @Command('session')
  @SocketPolicy(InfNeedsSession)
  public async session() {
    return 'unreachable';
  }

  @Command('caller')
  @SocketPolicy(InfNeedsCaller)
  public async caller() {
    return 'unreachable';
  }
}

describe('socket payloads through the ArgInputFilters; http error codes in details (G3)', function () {
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
    infWrite = ['*'];
    ScriptedSocketAuthz.checks = [];
    ScriptedSocketAuthz.script = () => ({ allowed: true, fields: { read: ['*'], write: infWrite } });
    t = await startServer();
    alice = await open(t, { auth: { clientId: 'inf-alice', token: 'good' } });
  });

  afterEach(async () => {
    alice.close();
    await t.close();
  });

  it('B17 strips the payload fields the @SocketAccess decision does not let the caller write', async () => {
    infWrite = ['id', 'title'];
    expect(resultOf(await command(alice, 'inf.update', { id: 'd1', title: 'new', owner: 'mallory' }))).to.deep.equal({ id: 'd1', title: 'new' });
  });

  it('B17 strips fields.neverRead ( Password ) even when the decision lets the caller write every field', async () => {
    expect(resultOf(await command(alice, 'inf.update', { id: 'd1', title: 'new', Password: 'hash' }))).to.deep.equal({ id: 'd1', title: 'new' });
  });

  it('checks a record payload declared with a primitive type as one field named payload, as http checks a primitive body parameter', async () => {
    infWrite = ['title'];
    expect(resultOf(await command(alice, 'inf.title', { title: 't', role: 'admin' }))).to.equal(null);
  });

  it('passes a primitive payload without the field filters: it has no field names (follow-up: check it by name, as http does)', async () => {
    infWrite = ['title'];
    expect(resultOf(await command(alice, 'inf.title', 'admin'))).to.equal('admin');
  });

  it('leaves the payload of a command without @SocketAccess untouched, as http leaves a route without @Access', async () => {
    expect(resultOf(await command(alice, 'inf.open', { login: 'alice', Password: 'secret' }))).to.deep.equal({ login: 'alice', Password: 'secret' });
  });

  it('answers a refused write invalid_argument with the error code and the refused fields in details', async () => {
    DI.register(InfRejectOwner).as(ArgInputFilter);
    DI.uncache(ArgInputFilter);
    try {
      expect(errorOf(await command(alice, 'inf.open', { title: 't', owner: 'x' }))).to.deep.equal({ code: 'invalid_argument', message: 'fields not writable: owner', retryable: false, details: { error: 'fields_not_writable', fields: ['owner'] } });
    } finally {
      DI.unregister(InfRejectOwner);
      DI.uncache(InfRejectOwner);
      DI.uncache(ArgInputFilter);
    }
  });

  it("answers a policy's stable code in details: forbidden", async () => {
    expect(errorOf(await command(alice, 'inf.session'))).to.deep.equal({ code: 'forbidden', message: 'this route needs a session, not a per-request credential', retryable: false, details: { error: 'session_required' } });
  });

  it("answers a policy's stable code in details: unauthenticated", async () => {
    expect(errorOf(await command(alice, 'inf.caller'))).to.deep.equal({ code: 'unauthenticated', message: 'this route needs an authenticated caller', retryable: false, details: { error: 'unauthenticated' } });
  });
});

describe('the real AuthzInputFieldFilter in reject mode (G3)', function () {
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
    // decisionFields reads the config only through an already resolved host AuthzDomains
    await DI.resolve(AuthzDomains);
    alice = await open(t, { auth: { clientId: 'inf-alice', token: 'good' } });
  });

  afterEach(async () => {
    alice.close();
    await t.close();
  });

  it('refuses a payload field the decision does not let the caller write, with the stable code and the fields', async () => {
    expect(errorOf(await command(alice, 'inf.update', { id: 'd1', title: 'new', owner: 'mallory' }))).to.deep.equal({ code: 'invalid_argument', message: 'fields not writable: owner', retryable: false, details: { error: 'fields_not_writable', fields: ['owner'] } });
  });

  it('refuses a record payload declared with a primitive type by its parameter name, payload', async () => {
    expect(errorOf(await command(alice, 'inf.title', { title: 't', role: 'admin' }))).to.deep.equal({ code: 'invalid_argument', message: 'fields not writable: payload', retryable: false, details: { error: 'fields_not_writable', fields: ['payload'] } });
  });
});
