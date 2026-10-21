import 'mocha';
import { expect } from 'chai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { AuthzDomains, AuthzService, ResourceAdapter } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { BaseSocketController } from '../src/controller.js';
import { Command, SocketController } from '../src/decorators.js';
import { SocketAccess, fromPayload } from '../src/access.js';
import { ISocketCallStorage } from '../src/interfaces.js';
import { ITestServer, command, errorOf, open, resultOf, startServer } from './harness.js';
import { ScriptedSocketAuthz, ScriptedSocketDomains } from './scripted-authz.js';

interface IInvoice {
  id: string;
  owner: string;
}

// owner '1' is the harness's alice
const INVOICES = new Map<string, IInvoice>([
  ['i1', { id: 'i1', owner: '1' }],
  ['i2', { id: 'i2', owner: 'bob' }],
]);

const loads: ResourceRef[] = [];

export class CondInvoiceAdapter extends ResourceAdapter<IInvoice> {
  public readonly kind = 'cond';
  public readonly types = ['invoice'];

  public accepts(_target: unknown): _target is IInvoice {
    return false;
  }

  public refOf(target: IInvoice): ResourceRef {
    return { type: 'invoice', id: target.id };
  }

  public async ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
    return [ref];
  }

  public async load(ref: ResourceRef): Promise<unknown> {
    loads.push(ref);
    return INVOICES.get(ref.id ?? '') ?? null;
  }
}

const decision = () => {
  const d = (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<ISocketCallStorage>).getStore()?.AuthzDecision;
  return { allowed: d?.allowed ?? null, residual: d?.residual.op ?? null };
};

@SocketController('cond')
export class ConditionalSocket extends BaseSocketController {
  @Command('read')
  @SocketAccess('invoice:read', { resource: fromPayload('id', 'invoice') })
  public async read() {
    return decision();
  }

  @Command('legacy')
  @SocketAccess('invoice:read', { resource: fromPayload('id', 'invoice'), subject: 'load' })
  public async legacy() {
    return decision();
  }

  @Command('action')
  @SocketAccess('invoice:read', { resource: fromPayload('id', 'invoice'), conditional: 'action' })
  public async action() {
    return decision();
  }

  @Command('memo')
  @SocketAccess('memo:read', { resource: fromPayload('id', 'memo') })
  public async memo() {
    return decision();
  }

  @Command('list')
  @SocketAccess('invoice:read')
  public async list() {
    return decision();
  }
}

describe('@SocketAccess conditional allow (M1), as authz-http AccessPolicy', function () {
  this.timeout(15000);

  let t: ITestServer;
  let alice: ClientSocket;

  before(() => {
    DI.register(ScriptedSocketAuthz).as(AuthzService);
    DI.register(ScriptedSocketDomains).as(AuthzDomains);
  });

  after(() => {
    DI.unregister(ScriptedSocketAuthz);
    DI.unregister(ScriptedSocketDomains);
    ScriptedSocketDomains.adapters = [];
  });

  beforeEach(async () => {
    ScriptedSocketDomains.adapters = [CondInvoiceAdapter];
    loads.length = 0;
    ScriptedSocketAuthz.checks = [];
    // the owner rule: a conditional allow until the row is known
    ScriptedSocketAuthz.script = (input) => {
      if (input.subject === undefined) {
        return { allowed: true, residual: { op: 'relation', relation: 'owner' } };
      }
      return (input.subject as IInvoice).owner === input.principal.id ? { allowed: true } : { allowed: false, reason: { code: 'residual_false' } };
    };
    t = await startServer();
    alice = await open(t, { auth: { clientId: 'cond-alice', token: 'good' } });
  });

  afterEach(async () => {
    alice.close();
    await t.close();
  });

  it("owner-rule-other-id: by default denies a conditional allow on another owner's row with the reason of the check against the row", async () => {
    const error = errorOf(await command(alice, 'cond.read', { id: 'i2' }));

    expect(error.code).to.equal('forbidden');
    expect(error.details).to.deep.include({ reason: { code: 'residual_false' } });
    expect(loads).to.deep.equal([{ type: 'invoice', id: 'i2' }]);
  });

  it('owner-rule-own-id: by default lets the owner through with a TRUE residual in the call storage', async () => {
    expect(resultOf(await command(alice, 'cond.read', { id: 'i1' }))).to.deep.equal({ allowed: true, residual: 'true' });
  });

  it("subject: 'load' still means conditional: 'load'", async () => {
    expect(errorOf(await command(alice, 'cond.legacy', { id: 'i2' })).code).to.equal('forbidden');
  });

  it("opt-out-action: conditional: 'action' runs the handler with the residual and loads nothing", async () => {
    expect(resultOf(await command(alice, 'cond.action', { id: 'i2' }))).to.deep.equal({ allowed: true, residual: 'relation' });
    expect(loads).to.have.length(0);
  });

  it('no-loader: denies a conditional allow on a type no ResourceAdapter can load with unknown_resource', async () => {
    expect(errorOf(await command(alice, 'cond.memo', { id: 'm1' })).details).to.deep.include({ reason: { code: 'unknown_resource' } });
  });

  it('type-only-resource: leaves a type-level conditional allow to the handler and loads nothing', async () => {
    expect(resultOf(await command(alice, 'cond.list'))).to.deep.equal({ allowed: true, residual: 'relation' });
    expect(loads).to.have.length(0);
  });
});
