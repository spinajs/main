import { expect } from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { DI } from '@spinajs/di';
import {
  defineSchedule,
  FakeClock,
  followOverSse,
  formatSseEvent,
  RunContext,
  RunEvent,
  RunModel,
  RunNotFound,
  RunStatus,
  Scheduler,
  ScheduledTask,
  SchedulerRunCommand,
  SchedulerRunShowCommand,
  ScheduleNotFound,
  SseParser,
  undefineSchedule,
} from '../src/index.js';
import { bootTestEnv } from './support/env.js';
import { captureConsole } from './support/console.js';
import { queuedRun } from './support/fixtures.js';

chai.use(chaiAsPromised);

const ev = (seq: number, status: RunStatus, runId = 'r1'): RunEvent => ({
  type: 'status',
  status,
  reason: null,
  id: 100 + seq,
  seq,
  runId,
  schedule: 's',
  attempt: 1,
  ts: '2026-01-05T10:00:00.000Z',
});
const progress = (seq: number, value: number, synthetic?: true): RunEvent => ({
  type: 'progress',
  progress: value,
  step: null,
  stepProgress: null,
  id: 100 + seq,
  seq,
  runId: 'r1',
  schedule: 's',
  attempt: 1,
  ts: '2026-01-05T10:00:00.000Z',
  ...(synthetic ? { synthetic } : {}),
});

type Handler = (req: IncomingMessage, res: ServerResponse, connection: number) => void;

/** One test SSE endpoint; `handler` answers each connection in turn. */
async function sseServer(handler: Handler) {
  const seen: Array<{ url?: string; lastEventId?: string; accept?: string; authorization?: string }> = [];
  const closed: number[] = [];
  let connection = 0;
  const server: Server = createServer((req, res) => {
    const n = connection++;
    seen.push({
      url: req.url,
      lastEventId: req.headers['last-event-id'] as string | undefined,
      accept: req.headers.accept,
      authorization: req.headers.authorization,
    });
    res.on('close', () => closed.push(n));
    handler(req, res, n);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    seen,
    closed,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
const stream = (res: ServerResponse) => res.writeHead(200, { 'Content-Type': 'text/event-stream' });

describe('SseParser', () => {
  it('parses frames split across chunks, multi-line data and comments', () => {
    const p = new SseParser();
    expect(p.push(': ping\n\nid: 1\nevent: status\nda')).to.deep.eq([]);
    expect(p.push('ta: {"a":\ndata: 1}\n\nid: 2\r\ndata: x\r\n\r\n')).to.deep.eq([
      { id: '1', event: 'status', data: '{"a":\n1}' },
      { id: '2', event: undefined, data: 'x' },
    ]);
  });

  it('keeps a CRLF split between chunks as one line end', () => {
    const p = new SseParser();
    expect(p.push('id: 3\r')).to.deep.eq([]);
    expect(p.push('\ndata: y\r\n\r')).to.deep.eq([]);
    expect(p.push('\n')).to.deep.eq([{ id: '3', event: undefined, data: 'y' }]);
  });
});

describe('followOverSse', () => {
  let srv: Awaited<ReturnType<typeof sseServer>> | undefined;
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
  });

  it('reconnects with Last-Event-ID until the terminal event', async () => {
    srv = await sseServer((_req, res, n) => {
      stream(res);
      if (n === 0) {
        res.write(formatSseEvent({ runId: 'r1' }, ev(1, 'running')));
        res.end();
        return;
      }
      res.write(': ping\n\n');
      res.end(formatSseEvent({ runId: 'r1' }, ev(2, 'succeeded')));
    });
    const got: number[] = [];
    await followOverSse(
      { baseUrl: srv.url, headers: { Authorization: 'Bearer t' } },
      {
        target: { runId: 'r1' },
        onEvent: (e) => got.push(e.seq),
        until: (e) => e.type === 'status' && e.status === 'succeeded',
      },
    );
    expect(got).to.deep.eq([1, 2]);
    expect(srv.seen.map((s) => s.lastEventId)).to.deep.eq([undefined, '1']);
    expect(srv.seen.every((s) => s.url === '/api/scheduler/runs/r1/events')).to.eq(true);
    expect(srv.seen.every((s) => s.authorization === 'Bearer t')).to.eq(true);
    expect(srv.seen.every((s) => s.accept === 'text/event-stream, application/json;q=0.5')).to.eq(true);
  });

  it('delivers synthetic progress that repeats the last id and resumes from the last real event', async () => {
    srv = await sseServer((_req, res, n) => {
      stream(res);
      if (n === 0) {
        res.write(formatSseEvent({ runId: 'r1' }, progress(6, 40)));
        res.write(formatSseEvent({ runId: 'r1' }, progress(6, 70, true)));
        res.end();
        return;
      }
      res.write(formatSseEvent({ runId: 'r1' }, progress(6, 90, true)));
      res.end(formatSseEvent({ runId: 'r1' }, ev(7, 'succeeded')));
    });
    const got: Array<[number, string, number | null, boolean]> = [];
    await followOverSse(
      { baseUrl: `${srv.url}/` },
      {
        target: { runId: 'r1' },
        after: 5,
        onEvent: (e) =>
          got.push([e.seq, e.type, e.type === 'progress' ? e.progress : null, e.type === 'progress' && !!e.synthetic]),
        until: (e) => e.type === 'status' && e.status === 'succeeded',
      },
    );
    expect(got).to.deep.eq([
      [6, 'progress', 40, false],
      [6, 'progress', 70, true],
      [6, 'progress', 90, true],
      [7, 'status', null, false],
    ]);
    expect(srv.seen.map((s) => s.lastEventId)).to.deep.eq(['5', '6']);
  });

  it('follows a schedule stream by journal position', async () => {
    srv = await sseServer((_req, res) => {
      stream(res);
      res.end(formatSseEvent({ schedule: 'daily report' }, ev(1, 'succeeded')));
    });
    const got: number[] = [];
    await followOverSse(
      { baseUrl: srv.url },
      { target: { schedule: 'daily report' }, after: 100, onEvent: (e) => got.push(e.id), until: () => true },
    );
    expect(got).to.deep.eq([101]);
    expect(srv.seen[0]).to.include({ url: '/api/scheduler/schedules/daily%20report/events', lastEventId: '100' });
  });

  it('stops at the terminal event without waiting for the server to close', async () => {
    srv = await sseServer((_req, res) => {
      stream(res);
      res.write(formatSseEvent({ runId: 'r1' }, ev(1, 'succeeded')));
    });
    await followOverSse({ baseUrl: srv.url }, { target: { runId: 'r1' }, onEvent: () => undefined, until: () => true });
    const server = srv;
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const check = () =>
        server.closed.includes(0)
          ? resolve()
          : Date.now() > deadline
          ? reject(new Error('still open'))
          : setTimeout(check, 10);
      check();
    });
  });

  it('maps 404 to the not-found errors of the contract', async () => {
    srv = await sseServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"not found"}');
    });
    const noop = { onEvent: () => undefined, until: () => true };
    await expect(followOverSse({ baseUrl: srv.url }, { target: { runId: 'r9' }, ...noop })).to.be.rejectedWith(
      RunNotFound,
    );
    await expect(followOverSse({ baseUrl: srv.url }, { target: { schedule: 'x' }, ...noop })).to.be.rejectedWith(
      ScheduleNotFound,
    );
    expect(srv.seen).to.have.length(2);
  });

  it('does not reconnect after a bad event or a failing callback', async () => {
    srv = await sseServer((_req, res, n) => {
      stream(res);
      res.end(n === 0 ? 'id: 1\ndata: {bad\n\n' : formatSseEvent({ runId: 'r1' }, ev(1, 'running')));
    });
    const target = { runId: 'r1' };
    await expect(
      followOverSse({ baseUrl: srv.url }, { target, onEvent: () => undefined, until: () => true }),
    ).to.be.rejectedWith(SyntaxError);
    const boom = new Error('boom');
    const onEvent = () => {
      throw boom;
    };
    await expect(followOverSse({ baseUrl: srv.url }, { target, onEvent, until: () => true })).to.be.rejectedWith(boom);
    expect(srv.seen).to.have.length(2);
  });

  it('gives up after five connections in a row without a new event', async () => {
    srv = await sseServer((_req, res) => {
      stream(res);
      res.end(': ping\n\n');
    });
    await expect(
      followOverSse({ baseUrl: srv.url }, { target: { runId: 'r1' }, onEvent: () => undefined, until: () => true }),
    ).to.be.rejectedWith(/closed 5 times/);
    expect(srv.seen).to.have.length(5);
  });
});

class CliFollowSteps extends ScheduledTask {
  public async execute(ctx: RunContext) {
    await ctx.step('only', () => 1);
  }
}

describe('scheduler:run:show --follow', () => {
  let clock: FakeClock;
  let out: ReturnType<typeof captureConsole>;
  let srv: Awaited<ReturnType<typeof sseServer>> | undefined;

  const boot = async (http?: { baseUrl: string }) => {
    ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:00Z', scheduler: http ? { cli: { http } } : {} }));
    out = captureConsole();
  };

  beforeEach(() => {
    process.exitCode = 0;
    defineSchedule(CliFollowSteps, 'follow-me', { manual: true });
  });
  afterEach(async () => {
    out.restore();
    process.exitCode = 0;
    undefineSchedule('follow-me');
    await srv?.close();
    srv = undefined;
  });

  it('streams the run in-process until it ends', async () => {
    await boot();
    const s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    const run = await queuedRun('follow-me', clock.now());
    await s.tickOnce();
    await s.idle();
    await (await DI.resolve(SchedulerRunShowCommand)).execute(run.Id, { follow: true });
    const text = out.lines.join('\n');
    expect(text).to.contain('--- following ---').and.contain('step     > only').and.contain('status   succeeded');
  });

  it('reads the SSE endpoint when scheduler.cli.http.baseUrl is set', async () => {
    let runId = '';
    srv = await sseServer((_req, res) => {
      stream(res);
      res.write(formatSseEvent({ runId }, ev(1, 'running', runId)));
      res.end(formatSseEvent({ runId }, ev(2, 'succeeded', runId)));
    });
    await boot({ baseUrl: srv.url });
    runId = (await queuedRun('follow-me', clock.now())).Id;
    await (await DI.resolve(SchedulerRunShowCommand)).execute(runId, { follow: true, json: true });
    expect(srv.seen.map((s) => s.url)).to.deep.eq([`/api/scheduler/runs/${runId}/events`]);
    expect(out.lines.map((l) => (JSON.parse(l) as RunEvent).seq)).to.deep.eq([1, 2]);
    expect(process.exitCode).to.eq(0);
  });

  it('scheduler:run --local follows in-process even with an HTTP endpoint configured', async () => {
    srv = await sseServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    await boot({ baseUrl: srv.url });
    await (await DI.resolve(SchedulerRunCommand)).execute('follow-me', { local: true, follow: true });
    expect(srv.seen).to.have.length(0);
    expect(out.lines.join('\n')).to.contain('step     < only succeeded');
    expect(process.exitCode).to.eq(0);
  });

  it('scheduler:run --follow without --local reads the SSE endpoint and exits 1 unless the run succeeded', async () => {
    // stands in for a server replica that ran the run and ended it dead
    srv = await sseServer((req, res) => {
      const runId = /runs\/([^/]+)\/events/.exec(req.url ?? '')?.[1] ?? '';
      void RunModel.update({ Status: 'dead', FinishedAt: clock.now() })
        .where('Id', runId)
        .then(() => {
          stream(res);
          res.end(formatSseEvent({ runId }, ev(1, 'dead', runId)));
        });
    });
    await boot({ baseUrl: srv.url });
    await (await DI.resolve(SchedulerRunCommand)).execute('follow-me', { follow: true });
    expect(srv.seen).to.have.length(1);
    expect(out.lines[0]).to.contain('status   dead');
    expect(out.lines[1]).to.match(/^run \S+ dead$/);
    expect(process.exitCode).to.eq(1);
  });
});
