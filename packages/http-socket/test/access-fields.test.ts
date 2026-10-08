import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { BasePolicy } from '@spinajs/http';
import { AuthzDomains, AuthzService } from '@spinajs/authz';
import { BaseSocketController } from '../src/controller.js';
import { Command, SocketController, SocketPolicy } from '../src/decorators.js';
import { SocketAccess, SocketAccessPolicy } from '../src/access.js';
import { AccessFieldsStage } from '../src/stages/access-fields.js';
import { ITestServer, command, errorOf, open, resultOf, startServer, waitFor } from './harness.js';
import { rawStream } from './stream-client.js';
import { ScriptedSocketAuthz } from './scripted-authz.js';

const ACF_NOTE = { id: 'n1', title: 't', body: 'b', Password: 'hash' };

export class AcfAllow extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {}
}

@SocketController('acf')
export class AccessFieldsSocket extends BaseSocketController {
  @Command('one')
  @SocketAccess('note:read', { fields: 'filter' })
  public async one() {
    return { ...ACF_NOTE };
  }

  @Command('many')
  @SocketAccess('note:read', { fields: 'filter' })
  public async many() {
    return [{ ...ACF_NOTE }, { ...ACF_NOTE, id: 'n2' }];
  }

  @Command('rows')
  @SocketAccess('note:read', { fields: 'filter' })
  public async *rows() {
    yield { ...ACF_NOTE };
    yield { ...ACF_NOTE, id: 'n2' };
  }

  @Command('raw')
  @SocketAccess('note:read')
  public async raw() {
    return { ...ACF_NOTE };
  }

  @Command('bytes')
  @SocketAccess('note:read', { fields: 'filter' })
  public async bytes() {
    return new Uint8Array([1, 2, 3]);
  }

  @Command('alt')
  @SocketAccess('note:write', { fields: 'filter' })
  @SocketPolicy(AcfAllow)
  public async alt() {
    return { ...ACF_NOTE };
  }
}

@SocketController('acfc')
@SocketAccess('note:list', { fields: 'filter' })
export class AccessFieldsClassSocket extends BaseSocketController {
  @Command('inherited')
  public async inherited() {
    return { ...ACF_NOTE };
  }
}

export const acfSources = { returned: 0, started: 0, pulls: 0 };

/** An async iterable that is not a generator: only its iterator's return() can release what it holds. */
function closable(items: unknown[], hang = false): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      acfSources.started++;
      let i = 0;
      return {
        next: () => (acfSources.pulls++, hang ? new Promise<IteratorResult<unknown>>(() => undefined) : Promise.resolve(i < items.length ? { done: false, value: items[i++] } : { done: true, value: undefined })),
        return: async () => {
          acfSources.returned++;
          return { done: true, value: undefined };
        },
      };
    },
  };
}

@SocketController('acfx')
export class AccessFieldsExtraSocket extends BaseSocketController {
  @Command('ssn')
  @SocketAccess('note:read', { fields: 'filter' })
  public async ssn() {
    return { ...ACF_NOTE, ssn: '123' };
  }

  @Command('tenant')
  @SocketAccess('note:tenant', { fields: 'filter', domain: 'tenant' })
  public async tenant() {
    return { id: 'n1', secret: 's', Password: 'hash' };
  }

  @Command('rootsecret')
  @SocketAccess('note:read', { fields: 'filter' })
  public async rootsecret() {
    return { id: 'n1', secret: 's' };
  }

  @Command('bytes')
  @SocketAccess('note:read', { fields: 'filter' })
  public async bytes() {
    return (async function* () {
      yield new Uint8Array([1, 2, 3]);
      yield { ...ACF_NOTE };
    })();
  }

  @Command('closable')
  @SocketAccess('note:read', { fields: 'filter' })
  public async closableSource() {
    return closable([{ ...ACF_NOTE }]);
  }

  @Command('hanging')
  @SocketAccess('note:read', { fields: 'filter' })
  public async hanging() {
    return closable([], true);
  }
}

@SocketController('acfo')
@SocketAccess('note:list', { fields: 'filter' })
export class AccessFieldsOverrideSocket extends BaseSocketController {
  @Command('own')
  @SocketAccess('note:read')
  public async own() {
    return { ...ACF_NOTE };
  }
}

/** Not registered: only its subclass is. */
@SocketAccess('note:list', { fields: 'filter' })
export class AccessFieldsBaseSocket extends BaseSocketController {
  @Command('inherited')
  public async inherited() {
    return { ...ACF_NOTE };
  }
}

@SocketController('acfs')
@SocketAccess('note:read')
export class AccessFieldsChildSocket extends AccessFieldsBaseSocket {}

describe("@SocketAccess fields: 'filter' (G4)", function () {
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
    ScriptedSocketAuthz.script = (input) => (input.permission === 'note:write' ? { allowed: false } : { allowed: true, fields: { read: ['id', 'title', 'Password'], write: ['*'] } });
    t = await startServer();
    alice = await open(t, { auth: { clientId: 'acf-alice', token: 'good' } });
  });

  afterEach(async () => {
    alice.close();
    await t.close();
  });

  it('B17 keeps the fields decision.fields.read allows, minus fields.neverRead', async () => {
    expect(resultOf(await command(alice, 'acf.one'))).to.deep.equal({ id: 'n1', title: 't' });
  });

  it('filters every element of a list result', async () => {
    expect(resultOf(await command(alice, 'acf.many'))).to.deep.equal([
      { id: 'n1', title: 't' },
      { id: 'n2', title: 't' },
    ]);
  });

  it('filters every chunk of a stream reply', async () => {
    const stream = rawStream(alice, 'acf.rows', null, 8);

    expect(await stream.reply).to.deep.include({ ok: true, stream: true });
    await stream.finished;
    expect(stream.chunks.map((c) => c.data)).to.deep.equal([
      { id: 'n1', title: 't' },
      { id: 'n2', title: 't' },
    ]);
    expect(stream.end).to.not.equal(null);
  });

  it("sends the result as the handler returned it without fields: 'filter'", async () => {
    expect(resultOf(await command(alice, 'acf.raw'))).to.deep.equal(ACF_NOTE);
  });

  it('passes a binary result through unchanged', async () => {
    expect(Array.from(resultOf(await command<Uint8Array>(alice, 'acf.bytes')))).to.deep.equal([1, 2, 3]);
  });

  it('applies the class rule to a handler without its own @SocketAccess', async () => {
    expect(resultOf(await command(alice, 'acfc.inherited'))).to.deep.equal({ id: 'n1', title: 't' });
  });

  it('drops only fields.neverRead for a call another policy group admitted: there is no decision', async () => {
    expect(resultOf(await command(alice, 'acf.alt'))).to.deep.equal({ id: 'n1', title: 't', body: 'b' });
  });

  it('removes a configured fields.neverRead, not only the default', async () => {
    await t.close();
    alice.close();
    ScriptedSocketAuthz.script = () => ({ allowed: true, fields: { read: ['*'], write: ['*'] } });
    t = await startServer({ authz: { fields: { neverRead: ['ssn'] } } });
    alice = await open(t, { auth: { clientId: 'acf-alice', token: 'good' } });

    expect(resultOf(await command(alice, 'acfx.ssn'))).to.deep.equal({ id: 'n1', title: 't', body: 'b', Password: 'hash' });
  });

  it("uses the neverRead of the decision's domain lineage", async () => {
    await t.close();
    alice.close();
    // a domain container resolves a fresh ScriptedSocketAuthz that answers as 'root'; the decision names its domain
    ScriptedSocketAuthz.script = (input) => ({ allowed: true, ...(input.permission === 'note:tenant' ? { domain: 'tenant' } : {}), fields: { read: ['*'], write: ['*'] } });
    t = await startServer({ authz: { domains: { tenant: { parent: 'root', fields: { neverRead: ['secret'] } } } } });
    (await DI.resolve(AuthzDomains)).create('tenant');
    alice = await open(t, { auth: { clientId: 'acf-alice', token: 'good' } });

    expect(resultOf(await command(alice, 'acfx.tenant'))).to.not.have.property('secret');
    expect(resultOf(await command(alice, 'acfx.rootsecret'))).to.deep.equal({ id: 'n1', secret: 's' });
  });

  it('passes a binary chunk of a stream unchanged and filters the object chunk after it', async () => {
    const stream = rawStream(alice, 'acfx.bytes', null, 8);

    await stream.reply;
    await stream.finished;
    expect(Array.from(new Uint8Array(stream.chunks[0].data as ArrayBuffer))).to.deep.equal([1, 2, 3]);
    expect(stream.chunks[1].data).to.deep.equal({ id: 'n1', title: 't' });
  });

  it('filters the chunks that follow a credit wait', async () => {
    const stream = rawStream(alice, 'acf.rows', null, 1);

    await stream.reply;
    await waitFor(() => stream.chunks.length === 1);
    expect(stream.chunks[0].data).to.deep.equal({ id: 'n1', title: 't' });
    stream.grant(1);
    await waitFor(() => stream.chunks.length === 2);
    expect(stream.chunks[1].data).to.deep.equal({ id: 'n2', title: 't' });
    stream.grant(1);
    await stream.finished;
  });

  it("lets a handler rule without fields override the class rule's filter", async () => {
    expect(resultOf(await command(alice, 'acfo.own'))).to.deep.equal(ACF_NOTE);
  });

  it('lets a subclass @SocketAccess replace the inherited class rule', async () => {
    expect(resultOf(await command(alice, 'acfs.inherited'))).to.deep.equal(ACF_NOTE);
  });

  describe('closing a stream result', () => {
    beforeEach(() => {
      acfSources.returned = 0;
      acfSources.started = 0;
      acfSources.pulls = 0;
    });

    it("closes the handler's source when openStream refuses the stream", async () => {
      expect(errorOf(await command(alice, 'acfx.closable')).code).to.equal('failed_precondition');
      expect(acfSources.returned).to.equal(1);
    });

    it('closes the source on a cancel during a pending next()', async () => {
      const stream = rawStream(alice, 'acfx.hanging', null, 4);

      await stream.reply;
      await waitFor(() => acfSources.pulls === 1);
      stream.cancel();
      await waitFor(() => acfSources.returned === 1);
    });
  });

  it('filters a value the source yields from its finally block when return() is called', async () => {
    const source = (async function* () {
      try {
        yield { id: 'n1' };
      } finally {
        yield { ...ACF_NOTE };
      }
    })();
    const ctx = { handler: { descriptor: { Policies: [[{ Type: SocketAccessPolicy, Options: [{ permissions: [], scope: 'handler', fields: 'filter' }] }]] }, controller: {} }, storage: {} };
    const stream = (await new AccessFieldsStage().execute(ctx as never, async () => source)) as AsyncIterable<unknown>;
    const iterator = stream[Symbol.asyncIterator]();

    await iterator.next();
    const step = await iterator.return!();
    expect(step.done).to.equal(false);
    expect(step.value).to.not.have.property('Password');
    expect(step.value).to.have.property('title', 't');
  });
});
