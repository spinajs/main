import 'mocha';
import { expect } from 'chai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { AuthenticationFailed, Forbidden } from '@spinajs/exceptions';
import { BasePolicy } from '@spinajs/http';
import { BaseSocketController } from '../src/controller.js';
import { Command, Payload, SocketController, SocketPolicy } from '../src/decorators.js';
import { ISocketCallStorage } from '../src/interfaces.js';
import { ISocketPolicyRequest } from '../src/policies.js';
import { ALICE, ITestServer, command, errorOf, open, resultOf, startServer } from './harness.js';

export const policySeen: Array<Record<string, unknown>> = [];

export class PolDeny extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {
    throw new Forbidden('denied by PolDeny');
  }
}

export class PolAllow extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {}
}

export class PolRequireUser extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(req: unknown): Promise<void> {
    if (!(req as ISocketPolicyRequest).storage.Principal.authenticated) {
      throw new AuthenticationFailed('login required');
    }
  }
}

export class PolInspect extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(req: unknown): Promise<void> {
    const r = req as ISocketPolicyRequest;
    // policies run inside the call's AsyncLocalStorage store ( D14 ), as AuthzService.current() will need
    const ambient = (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<ISocketCallStorage>).getStore();
    policySeen.push({ body: r.body, params: r.params, user: r.storage.Principal.identity ?? null, ambient: ambient?.Principal.id ?? null, method: r.method, url: r.originalUrl, clientId: r.socketConnection.clientId });
  }
}

export class PolDisabled extends BasePolicy {
  public isEnabled(): boolean {
    return false;
  }

  public async execute(): Promise<void> {
    throw new Forbidden('never runs');
  }
}

@SocketController('pol')
@SocketPolicy(PolRequireUser)
export class PolicySocket extends BaseSocketController {
  @Command('open')
  public async open() {
    return 'opened';
  }

  @Command('deny')
  @SocketPolicy(PolDeny)
  public async deny() {
    return 'unreachable';
  }

  @Command('both')
  @SocketPolicy([PolAllow, PolDeny])
  public async both() {
    return 'unreachable';
  }

  @Command('either')
  @SocketPolicy(PolDeny)
  @SocketPolicy(PolAllow)
  public async either() {
    return 'one path is enough';
  }

  @Command('inspect')
  @SocketPolicy(PolInspect)
  public async inspect() {
    return 'inspected';
  }

  @Command('disabled')
  @SocketPolicy(PolDisabled)
  public async disabled() {
    return 'not guarded';
  }

  @Command('strict', { schema: { type: 'object', required: ['x'] } })
  @SocketPolicy(PolDeny)
  public async strict(@Payload() _payload: unknown) {
    return 'unreachable';
  }
}

describe('socket command policies', function () {
  this.timeout(15000);

  let t: ITestServer;
  let anonymous: ClientSocket;
  let alice: ClientSocket;

  beforeEach(async () => {
    t = await startServer();
    anonymous = await open(t, { auth: { clientId: 'pol-anon' } });
    alice = await open(t, { auth: { clientId: 'pol-client', token: 'good' } });
  });

  afterEach(async () => {
    anonymous.close();
    alice.close();
    await t.close();
  });

  it('answers unauthenticated when a controller policy needs a user', async () => {
    expect(errorOf(await command(anonymous, 'pol.open'))).to.deep.equal({ code: 'unauthenticated', message: 'login required', retryable: false });
  });

  it('runs the command when every policy holds', async () => {
    expect(resultOf(await command(alice, 'pol.open'))).to.equal('opened');
  });

  it('answers forbidden from a method policy', async () => {
    expect(errorOf(await command(alice, 'pol.deny'))).to.deep.equal({ code: 'forbidden', message: 'denied by PolDeny', retryable: false });
  });

  it('requires every policy of one group (AND)', async () => {
    expect(errorOf(await command(alice, 'pol.both')).code).to.equal('forbidden');
  });

  it('accepts any one of several groups (OR)', async () => {
    expect(resultOf(await command(alice, 'pol.either'))).to.equal('one path is enough');
  });

  it('hands policies a request built from the call', async () => {
    await command(alice, 'pol.inspect', { doc: 7 });
    expect(policySeen[policySeen.length - 1]).to.deep.equal({ body: { doc: 7 }, params: { doc: 7 }, user: ALICE, ambient: '1', method: 'SOCKET', url: 'pol.inspect', clientId: 'pol-client' });
  });

  it('skips a policy that is not enabled for the command', async () => {
    expect(resultOf(await command(alice, 'pol.disabled'))).to.equal('not guarded');
  });

  it('checks policies before validating arguments', async () => {
    expect(errorOf(await command(alice, 'pol.strict', {})).code).to.equal('forbidden');
  });
});
