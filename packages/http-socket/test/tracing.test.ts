import 'mocha';
import { expect } from 'chai';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { Socket as ClientSocket } from 'socket.io-client';
import { Injectable } from '@spinajs/di';
import { resetTracing, useInMemorySpans } from '@spinajs/tracing/testing';
import type { InMemorySpans } from '@spinajs/tracing/testing';

import { BaseSocketController } from '../src/controller.js';
import { Command, Payload, SocketController } from '../src/decorators.js';
import { ISocketCommandContext, STAGE_ORDER, SocketMiddleware } from '../src/interfaces.js';
import { ITestServer, command, open, startServer } from './harness.js';

/** The ids of the call storage, as every log line and policy of a `trc.` command reads them. */
export const trcIds: Array<{ traceId: string; spanId: string }> = [];

@Injectable(SocketMiddleware)
export class TrcIdsStage extends SocketMiddleware {
  public get Order(): number {
    return STAGE_ORDER.Lookup + 60;
  }

  public async onAround(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    const { traceId, spanId } = ctx.storage;
    if (ctx.handler?.fullName.startsWith('trc.') && typeof traceId === 'string' && typeof spanId === 'string') {
      trcIds.push({ traceId, spanId });
    }
    return next();
  }
}

@SocketController('trc')
export class TrcSocket extends BaseSocketController {
  @Command('echo')
  public async echo(@Payload() payload: unknown) {
    return payload;
  }

  @Command('fail')
  public async fail(): Promise<never> {
    throw new Error('boom');
  }
}

const PARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('socket command spans', function () {
  this.timeout(15000);

  let t: ITestServer;
  let socket: ClientSocket;
  let spans: InMemorySpans;

  beforeEach(async () => {
    trcIds.length = 0;
    spans = useInMemorySpans();
    t = await startServer();
    socket = await open(t);
  });

  afterEach(async () => {
    socket.close();
    await t.close();
    await spans.detach();
  });

  after(() => resetTracing());

  it('continues the request traceparent as a SERVER span named after the command', async () => {
    await command(socket, 'trc.echo', 1, { id: 'c-1', traceparent: PARENT });
    const span = await spans.waitFor('socket trc.echo');
    expect(span.kind).to.equal(SpanKind.SERVER);
    expect(span.spanContext().traceId).to.equal('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(span.parentSpanContext?.spanId).to.equal('00f067aa0ba902b7');
    expect(span.attributes['spina.socket.command']).to.equal('trc.echo');
    expect(trcIds).to.deep.equal([{ traceId: span.spanContext().traceId, spanId: span.spanContext().spanId }]);
  });

  it('starts a new trace without a traceparent', async () => {
    await command(socket, 'trc.echo', 1);
    expect((await spans.waitFor('socket trc.echo')).parentSpanContext).to.equal(undefined);
  });

  it('marks a failed command ERROR with the wire error code and without the error text', async () => {
    await command(socket, 'trc.fail', null);
    const span = await spans.waitFor('socket trc.fail');
    expect(span.status.code).to.equal(SpanStatusCode.ERROR);
    expect(span.attributes['error.type']).to.be.a('string');
    expect(span.status.message).to.equal(span.attributes['error.type']);
    expect(JSON.stringify({ status: span.status, attributes: span.attributes, events: span.events })).to.not.contain('boom');
  });

  it('names an unknown command _OTHER, so a client cannot mint span names', async () => {
    await command(socket, 'trc.nope', null);
    expect((await spans.waitFor('socket _OTHER')).attributes['spina.socket.command']).to.equal('trc.nope');
  });
});

describe('socket call storage while tracing is not started', function () {
  this.timeout(15000);

  let t: ITestServer;
  let socket: ClientSocket;

  beforeEach(async () => {
    await resetTracing();
    trcIds.length = 0;
    t = await startServer();
    socket = await open(t);
  });

  afterEach(async () => {
    socket.close();
    await t.close();
  });

  it('mints ids that are not zero for a command without a traceparent', async () => {
    await command(socket, 'trc.echo', 1);

    const [ids] = trcIds;
    expect(ids.traceId).to.match(/^[0-9a-f]{32}$/).and.not.match(/^0+$/);
    expect(ids.spanId).to.match(/^[0-9a-f]{16}$/).and.not.match(/^0+$/);
  });

  it('keeps the inbound trace id and mints a span id of its own', async () => {
    await command(socket, 'trc.echo', 1, { traceparent: PARENT });

    const [ids] = trcIds;
    expect(ids.traceId).to.equal('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(ids.spanId).to.match(/^[0-9a-f]{16}$/).and.not.equal('00f067aa0ba902b7');
  });
});
