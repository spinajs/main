import 'mocha';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { expect } from 'chai';
import sinon from 'sinon';
import { audit } from '@spinajs/audit';
import type { StoredAuditEvent } from '@spinajs/audit';
import { MemoryAuditStore } from '@spinajs/audit/testing';
import { BadRequest, Forbidden } from '@spinajs/exceptions';
import { BaseController, BasePath, BasePolicy, Get, HttpServer, Middleware, Ok, Policy, Post } from '@spinajs/http';
import type { TestApp } from '@spinajs/testing';

import { Audit } from '../src/index.js';
import { appPort, auditApp, bootFailure } from './support/app.js';

// a delay no other timer of the request uses: the wait is found by it
const WAIT_MS = 4321;

/** Holds an action or a policy until the test opens it; `entered` resolves once something is held. */
class Gate {
  public entered!: Promise<void>;
  private enter!: () => void;
  private release!: () => void;
  private held!: Promise<void>;

  constructor() {
    this.reset();
  }

  public reset(): void {
    this.entered = new Promise((resolve) => (this.enter = resolve));
    this.held = new Promise((resolve) => (this.release = resolve));
  }

  public pass(): Promise<void> {
    this.enter();
    return this.held;
  }

  public open(): void {
    this.release();
  }
}

const gate = new Gate();

class HeldPolicy extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {
    await gate.pass();
    throw new Forbidden('not yours');
  }
}

@BasePath('left')
class LeftController extends BaseController {
  @Get()
  @Middleware(Audit)
  public async commits() {
    await gate.pass();
    return new Ok({ ok: true });
  }

  @Get()
  @Middleware(Audit)
  public async throws() {
    await gate.pass();
    throw new BadRequest('stopped on the abort signal');
  }

  @Get()
  @Policy(HeldPolicy)
  @Middleware(Audit)
  public refused() {
    return new Ok({ ok: true });
  }

  @Post()
  @Middleware(Audit, { trail: 'restricted' })
  public async vault() {
    await gate.pass();
    return new Ok({ ok: true });
  }
}

const TRAILS = {
  default: { store: 'MemoryAuditStore', retry: { attempts: 1 } },
  restricted: { store: 'MemoryAuditStore', onFailure: 'reject', retry: { attempts: 1 } },
};

const dataOf = (event: StoredAuditEvent) => event.data as Record<string, unknown>;
const turn = () => new Promise((resolve) => setImmediate(resolve));

/** Sends a request and goes away once the route holds it at the gate. */
async function leave(path: string, method = 'GET'): Promise<void> {
  const request = http.request({ host: 'localhost', port: appPort(), path: `/${path}`, method });
  request.on('error', () => undefined);
  request.end();
  await gate.entered;
  request.destroy();
}

// setTimeout is faked, so the polls below turn the event loop with setImmediate and measure real time.
async function until<T>(found: () => T | undefined, what: string): Promise<T> {
  const end = performance.now() + 10000;
  for (;;) {
    const value = found();
    if (value !== undefined) return value;
    if (performance.now() > end) throw new Error(`${what} within 10 s`);
    await turn();
  }
}

async function eventsOf(trail: string, count: number): Promise<readonly StoredAuditEvent[]> {
  const end = performance.now() + 10000;
  for (;;) {
    await audit().flush();
    const events = MemoryAuditStore.events(trail);
    if (events.length >= count) return events;
    if (performance.now() > end) throw new Error(`trail ${trail} never held ${count} events`);
    await turn();
  }
}

async function recorded(trail = 'default'): Promise<readonly StoredAuditEvent[]> {
  await turn();
  await audit().flush();
  return MemoryAuditStore.events(trail);
}

describe('Audit of a request the client went away from', function () {
  this.timeout(20000);

  let app: TestApp;
  let clock: sinon.SinonFakeTimers;
  let timers: sinon.SinonSpy<Parameters<typeof setTimeout>, ReturnType<typeof setTimeout>>;

  /** The timer of the wait `Audit` began for an aborted request. */
  const waiting = () => until(() => timers.getCalls().find((call) => call.args[1] === WAIT_MS)?.returnValue, 'Audit did not begin to wait');

  before(async () => {
    app = await auditApp({ audit: { trails: TRAILS, http: { abortWaitMs: WAIT_MS } }, controllers: [LeftController] });
  });

  after(() => app.dispose());

  beforeEach(() => {
    MemoryAuditStore.clear();
    gate.reset();
    clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    timers = sinon.spy(globalThis, 'setTimeout');
  });

  afterEach(() => {
    gate.open();
    timers.restore();
    clock.restore();
  });

  it('waits for the action and records ok when it succeeds after the client left', async () => {
    const listeners = () => app.container.listenerCount('http.server.closing');
    const before = listeners();

    await leave('left/commits');
    await waiting();
    expect(await recorded()).to.have.length(0);
    expect(listeners()).to.eq(before + 1);

    gate.open();
    const [event] = await eventsOf('default', 1);
    expect(event.outcome).to.eq('ok');
    expect(dataOf(event).aborted).to.eq(true);
    expect(dataOf(event)).to.not.have.property('status');
    expect(dataOf(event)).to.not.have.property('error');
    expect(listeners()).to.eq(before);
  });

  it('records failed with the error when the action throws after the client left', async () => {
    await leave('left/throws');
    await waiting();

    gate.open();
    const [event] = await eventsOf('default', 1);
    expect(event.outcome).to.eq('failed');
    expect(dataOf(event).aborted).to.eq(true);
    expect(dataOf(event).error).to.deep.eq({ name: 'BadRequest', message: 'stopped on the abort signal' });
  });

  it('records an attempt when the action still runs after abortWaitMs; the wait does not keep the process alive', async () => {
    await leave('left/commits');
    const timer = await waiting();
    expect(timer.hasRef()).to.eq(false);

    await clock.tickAsync(WAIT_MS - 1);
    expect(await recorded()).to.have.length(0);

    await clock.tickAsync(1);
    const [event] = await eventsOf('default', 1);
    expect(event.outcome).to.eq('attempt');
    expect(dataOf(event).aborted).to.eq(true);
  });

  it('records a policy refusal after the client left as denied', async () => {
    await leave('left/refused');
    await waiting();

    gate.open();
    const [event] = await eventsOf('default', 1);
    expect(event.outcome).to.eq('denied');
    expect(dataOf(event).aborted).to.eq(true);
    expect(dataOf(event).error).to.deep.eq({ name: 'Forbidden', message: 'not yours' });
  });

  it('writes one outcome beside the confirmed attempt of a reject trail', async () => {
    await leave('left/vault', 'POST');
    await waiting();
    gate.open();

    const [attempt, outcome] = await eventsOf('restricted', 2);
    expect([attempt.outcome, outcome.outcome]).to.deep.eq(['attempt', 'ok']);
    expect(dataOf(outcome).invocation).to.be.a('string').and.eq(dataOf(attempt).invocation);
    expect(dataOf(outcome).aborted).to.eq(true);
    expect(await recorded('restricted')).to.have.length(2);
  });
});

@BasePath('left-forever')
class ForeverController extends BaseController {
  @Get()
  @Middleware(Audit, { abortWaitMs: 2 ** 31 })
  public forever() {
    return new Ok({ ok: true });
  }
}

describe('abortWaitMs', function () {
  this.timeout(20000);

  it('fails the boot past the longest delay a timer takes', async () => {
    expect(await bootFailure({ audit: { trails: TRAILS }, controllers: [ForeverController] })).to.contain('abortWaitMs must be a whole number of milliseconds, 0 to 2147483647');
  });

  it('fails the boot when audit.http sets it below 0', async () => {
    expect(await bootFailure({ audit: { trails: TRAILS, http: { abortWaitMs: -1 } }, controllers: [LeftController] })).to.contain('audit.http.abortWaitMs');
  });
});

describe('Audit of a request the client went away from, at shutdown', function () {
  this.timeout(20000);

  beforeEach(() => {
    MemoryAuditStore.clear();
    gate.reset();
  });

  afterEach(() => gate.open());

  it('ends a pending wait as an attempt when the http server begins to close', async () => {
    const app = await auditApp({ audit: { trails: TRAILS }, controllers: [LeftController] });
    const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const timers = sinon.spy(globalThis, 'setTimeout');
    try {
      await leave('left/commits');
      // the default wait, which the fake clock never reaches
      await until(() => timers.getCalls().find((call) => call.args[1] === 30000), 'Audit did not begin to wait');
      await (await app.resolve(HttpServer)).stop();

      const [event] = await eventsOf('default', 1);
      expect(event.outcome).to.eq('attempt');
      expect(dataOf(event).aborted).to.eq(true);
    } finally {
      timers.restore();
      clock.restore();
      await app.dispose();
    }
  });
});
