import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { BaseSocketController } from '../src/controller.js';
import { Command, Payload, SocketController } from '../src/decorators.js';
import { ISocketCommandContext, SocketCommandStage } from '../src/interfaces.js';
import { DI } from '@spinajs/di';
import { SizeStage } from '../src/stages/limits.js';
import { assertLimitsConfig } from '../src/limits.js';
import { ITestServer, command, delay, errorOf, open, resultOf, startServer } from './harness.js';

let release: () => void = () => undefined;
let gate: Promise<void> = Promise.resolve();

@SocketController('lim')
export class LimitSocket extends BaseSocketController {
  @Command('echo')
  public async echo(@Payload() payload: unknown) {
    return payload;
  }

  @Command('hold')
  public async hold() {
    await gate;
    return 'released';
  }
}

describe('socket pipeline limits', function () {
  this.timeout(15000);

  let t: ITestServer | undefined;
  let socket: ClientSocket | undefined;

  afterEach(async () => {
    socket?.close();
    await t?.close();
    socket = undefined;
    t = undefined;
  });

  it('answers an oversized payload with a non-retryable resource_exhausted', async () => {
    t = await startServer({ http: { socket: { maxPayloadBytes: 1024 } } });
    socket = await open(t);

    const error = errorOf(await command(socket, 'lim.echo', 'x'.repeat(1500)));
    expect(error).to.include({ code: 'resource_exhausted', retryable: false });
    expect(error.details).to.deep.equal({ size: 1502, limit: 1024 });
    expect(resultOf(await command(socket, 'lim.echo', 'small'))).to.equal('small');
  });

  it('answers a burst over the rate with resource_exhausted and retryAfterMs', async () => {
    t = await startServer({ http: { socket: { rate: { perSecond: 1, burst: 2 } } } });
    socket = await open(t);

    const replies = await Promise.all([1, 2, 3].map((n) => command(socket!, 'lim.echo', n)));
    expect(replies.filter((r) => r.ok)).to.have.length(2);

    const error = errorOf(replies[2]);
    expect(error).to.include({ code: 'resource_exhausted', retryable: true });
    expect(error.retryAfterMs).to.be.greaterThan(0).and.at.most(1000);
  });

  it('answers commands over the in-flight limit with resource_exhausted and retryAfterMs', async () => {
    t = await startServer({ http: { socket: { maxInFlightPerConnection: 2 } } });
    socket = await open(t);
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = command(socket, 'lim.hold');
    const second = command(socket, 'lim.hold');
    await delay(50);

    expect(errorOf(await command(socket, 'lim.hold'))).to.deep.equal({ code: 'resource_exhausted', message: 'more than 2 commands in flight on this connection', retryable: true, retryAfterMs: 100 });

    release();
    expect(resultOf(await first)).to.equal('released');
    expect(resultOf(await second)).to.equal('released');
    expect(resultOf(await command(socket, 'lim.hold'))).to.equal('released');
  });

  describe('a payload that cannot be measured', () => {
    const stage = async (payload: unknown) => {
      t = await startServer();
      const stages = (await DI.resolve(Array.ofType(SocketCommandStage))) as SocketCommandStage[];
      const size = stages.find((s) => s instanceof SizeStage)!;
      return size.execute({ payload } as ISocketCommandContext, async () => 'next');
    };

    it('maps a BigInt payload to invalid_argument', async () => {
      const err = await stage({ n: 10n }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).to.include({ code: 'invalid_argument', retryable: false });
    });

    it('maps a cyclic payload to invalid_argument', async () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;

      const err = await stage(cyclic).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).to.include({ code: 'invalid_argument', retryable: false });
    });
  });

  describe('limit configuration', () => {
    const cfg = (rate: { perSecond: number; burst: number }) => ({ rate }) as Parameters<typeof assertLimitsConfig>[0];

    for (const bad of [{ perSecond: 0, burst: 10 }, { perSecond: -1, burst: 10 }, { perSecond: 10, burst: 0 }, { perSecond: NaN, burst: 10 }]) {
      it(`rejects ${JSON.stringify(bad)} with a RangeError`, () => {
        expect(() => assertLimitsConfig(cfg(bad))).to.throw(RangeError);
      });
    }

    it('accepts positive values', () => {
      expect(() => assertLimitsConfig(cfg({ perSecond: 1, burst: 1 }))).not.to.throw();
    });

    it('aborts server startup on a non-positive rate', async () => {
      let failure: unknown;
      try {
        t = await startServer({ http: { socket: { rate: { perSecond: 0, burst: 5 } } } });
      } catch (e) {
        failure = e;
      }
      expect(failure).to.be.instanceOf(RangeError);
    });
  });
});
