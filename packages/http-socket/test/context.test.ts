import 'mocha';
import { expect } from 'chai';
import { SocketException } from '@spinajs/http-socket-common';
import { SocketCommandContext } from '../src/context.js';
import { IConnectionRuntime, ISocketCallStorage } from '../src/interfaces.js';
import { delay } from './harness.js';

describe('SocketCommandContext deadlines', () => {
  const contexts: SocketCommandContext[] = [];

  const create = () => {
    const ctx = new SocketCommandContext({} as IConnectionRuntime, { id: 'ctx-1', name: 'ctx.cmd', payload: null }, {} as ISocketCallStorage);
    contexts.push(ctx);
    return ctx;
  };

  const timerOf = (ctx: SocketCommandContext) => (ctx as unknown as { timer: unknown }).timer;

  afterEach(() => {
    contexts.forEach((ctx) => ctx.dispose());
    contexts.length = 0;
  });

  it('arms no timer once the command is aborted', () => {
    const ctx = create();
    ctx.abort(new SocketException('cancelled', 'cancelled by the client'));

    ctx.armDeadline(1_000);

    expect(timerOf(ctx)).to.equal(null);
  });

  it('does not fire a deadline longer than the longest timer delay at once', async () => {
    const ctx = create();

    ctx.armDeadline(2 ** 31 + 1_000);
    await delay(50);

    expect(ctx.signal.aborted).to.be.false;
  });

  it('still fires a short deadline', async () => {
    const ctx = create();

    ctx.armDeadline(20);
    await delay(60);

    expect(ctx.signal.aborted).to.be.true;
    expect((ctx.signal.reason as SocketException).code).to.equal('deadline_exceeded');
  });
});
