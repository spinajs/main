import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { BasePolicy } from '@spinajs/http';
import { AuthzService } from '@spinajs/authz';
import { BaseSocketController } from '../src/controller.js';
import { Command, SocketController, SocketPolicy } from '../src/decorators.js';
import { SocketAccess } from '../src/access.js';
import { ITestServer, command, open, resultOf, startServer } from './harness.js';
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
});
