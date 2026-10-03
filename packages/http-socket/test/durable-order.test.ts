import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { ArgHydrator, BasePolicy, Hydrator } from '@spinajs/http';
import { ErrorCode, SocketException } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, Payload, SocketController, SocketPolicy } from '../src/decorators.js';
import type { ISocketPolicyRequest } from '../src/policies.js';
import { ITestServer, command, delay, errorOf, open, resultOf, startServer, waitFor } from './harness.js';
import { killConnections } from './faults.js';

export const fenceLog: string[] = [];
let fenceGate: { promise: Promise<void>; open: () => void };

function newFenceGate(): void {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  fenceGate = { promise, open };
}

/** Documents created by `fence.create`; edits and renames of a missing one fail for good. */
export const fenceDocs = new Set<string>();

export class FenceDocHydrator extends ArgHydrator {
  public async hydrate(input: { id: string }): Promise<FenceDoc> {
    if (!fenceDocs.has(input.id)) {
      throw new SocketException('not_found', `document ${input.id} not found`);
    }
    return new FenceDoc(input.id);
  }
}

@Hydrator(FenceDocHydrator)
export class FenceDoc {
  constructor(public id: string) {}
}

export class FenceDocExists extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(req: unknown): Promise<void> {
    const id = (req as ISocketPolicyRequest).params.id as string;
    if (!fenceDocs.has(id)) {
      throw new SocketException('forbidden', `document ${id} is not yours`);
    }
  }
}

@SocketController('fence')
export class FenceSocket extends BaseSocketController {
  @Command('step', { idempotent: true, ordered: 'client' })
  public async step(@Payload() p: { tag: string; ms?: number; fail?: ErrorCode }) {
    fenceLog.push(p.tag);
    if (p.ms) {
      await delay(p.ms);
    }
    if (p.fail) {
      throw new SocketException(p.fail, `${p.tag} failed`);
    }
    return p.tag;
  }

  @Command('hang', { idempotent: true, ordered: 'client', timeoutMs: 50 })
  public async hang(@Payload() p: { tag: string }) {
    fenceLog.push(p.tag);
    await fenceGate.promise;
    fenceLog.push(`${p.tag}:end`);
    return p.tag;
  }

  /** hangs like `hang`, but only a disconnect or a cancel aborts it */
  @Command('wait', { idempotent: true, ordered: 'client' })
  public async wait(@Payload() p: { tag: string }) {
    fenceLog.push(p.tag);
    await fenceGate.promise;
    fenceLog.push(`${p.tag}:end`);
    return p.tag;
  }

  @Command('create', { idempotent: true, ordered: 'client' })
  public async create(@Payload() p: { id: string; ms?: number }) {
    fenceLog.push(`create:${p.id}`);
    await delay(p.ms ?? 0);
    fenceDocs.add(p.id);
    return p.id;
  }

  @Command('edit', { idempotent: true, ordered: 'client' })
  public async edit(@Payload() doc: FenceDoc) {
    fenceLog.push(`edit:${doc.id}`);
    return doc.id;
  }

  @Command('rename', { idempotent: true, ordered: 'client' })
  @SocketPolicy(FenceDocExists)
  public async rename(@Payload() p: { id: string }) {
    fenceLog.push(`rename:${p.id}`);
    return p.id;
  }

  @Command('loose', { idempotent: true })
  public async loose() {
    fenceLog.push('loose');
    return 'loose';
  }
}

describe('durable command order: the after fence', function () {
  this.timeout(15000);

  let t: ITestServer;
  let sockets: ClientSocket[] = [];

  const connect = async (clientId: string, cfg?: Record<string, unknown>, token?: string) => {
    if (cfg) {
      await t.close();
      t = await startServer(cfg);
    }
    const socket = await open(t, { auth: { clientId, ...(token ? { token } : {}) } });
    sockets.push(socket);
    return socket;
  };

  beforeEach(async () => {
    fenceLog.length = 0;
    fenceDocs.clear();
    newFenceGate();
    t = await startServer();
  });

  afterEach(async () => {
    fenceGate.open();
    sockets.forEach((s) => s.close());
    sockets = [];
    await t.close();
  });

  it('runs a command whose predecessor completed', async () => {
    const s = await connect('fence-done');
    expect(resultOf(await command(s, 'fence.step', { tag: 'a' }, { idempotencyKey: 'a' }))).to.equal('a');
    expect(resultOf(await command(s, 'fence.step', { tag: 'b' }, { idempotencyKey: 'b', after: 'a' }))).to.equal('b');
  });

  it('accepts a predecessor that completed on an earlier connection of the client', async () => {
    const first = await connect('fence-reconnect');
    await command(first, 'fence.step', { tag: 'a' }, { idempotencyKey: 'a' });
    first.close();

    const second = await connect('fence-reconnect');
    expect(resultOf(await command(second, 'fence.step', { tag: 'b' }, { idempotencyKey: 'b', after: 'a' }))).to.equal('b');
  });

  it('refuses a command whose predecessor never arrived, with a retryable unavailable naming the predecessor', async () => {
    const s = await connect('fence-missing');
    const error = errorOf(await command(s, 'fence.step', { tag: 'b' }, { idempotencyKey: 'b', after: 'zzz' }));

    expect(error).to.deep.include({ code: 'unavailable', retryable: true, details: { after: 'zzz' } });
    expect(fenceLog).to.deep.equal([]);
  });

  it('lets a command sent right behind its predecessor wait for it', async () => {
    const s = await connect('fence-pipelined');
    const [a, b] = await Promise.all([command(s, 'fence.step', { tag: 'a', ms: 100 }, { idempotencyKey: 'a' }), command(s, 'fence.step', { tag: 'b' }, { idempotencyKey: 'b', after: 'a' })]);

    expect([resultOf(a), resultOf(b)]).to.deep.equal(['a', 'b']);
    expect(fenceLog).to.deep.equal(['a', 'b']);
  });

  it('does not block behind a predecessor that failed for good', async () => {
    const s = await connect('fence-final');
    const [a, b] = await Promise.all([command(s, 'fence.step', { tag: 'a', fail: 'conflict' }, { idempotencyKey: 'a' }), command(s, 'fence.step', { tag: 'b' }, { idempotencyKey: 'b', after: 'a' })]);

    expect(errorOf(a).code).to.equal('conflict');
    expect(resultOf(b)).to.equal('b');
  });

  it('blocks behind a predecessor that failed retryably, and releases the blocked key', async () => {
    const s = await connect('fence-retryable');
    const [a, b] = await Promise.all([command(s, 'fence.step', { tag: 'a', fail: 'unavailable' }, { idempotencyKey: 'a' }), command(s, 'fence.step', { tag: 'b' }, { idempotencyKey: 'b', after: 'a' })]);

    expect(errorOf(a).code).to.equal('unavailable');
    expect(errorOf(b)).to.deep.include({ code: 'unavailable', retryable: true, details: { after: 'a' } });
    expect(fenceLog).to.deep.equal(['a']);

    // both keys were released: the resend in order runs them
    expect(resultOf(await command(s, 'fence.step', { tag: 'a' }, { idempotencyKey: 'a' }))).to.equal('a');
    expect(resultOf(await command(s, 'fence.step', { tag: 'b' }, { idempotencyKey: 'b', after: 'a' }))).to.equal('b');
  });

  it('records a predecessor that finished after its deadline, so its successor runs and a resend replays it', async () => {
    const s = await connect('fence-late');
    const a = command(s, 'fence.hang', { tag: 'a' }, { idempotencyKey: 'a' });
    const b = command(s, 'fence.step', { tag: 'b' }, { idempotencyKey: 'b', after: 'a' });

    expect(errorOf(await a).code).to.equal('deadline_exceeded');
    await delay(50);
    fenceGate.open();

    expect(resultOf(await b)).to.equal('b');
    expect(resultOf(await command(s, 'fence.hang', { tag: 'a' }, { idempotencyKey: 'a' }))).to.equal('a');
    expect(fenceLog).to.deep.equal(['a', 'a:end', 'b']);
  });

  it('keeps the key of a handler cut loose after the abort grace running, so its successor waits for it', async () => {
    const s = await connect('fence-loose', { http: { socket: { ordering: { abortGraceMs: 200 } } } });
    const a = command(s, 'fence.hang', { tag: 'a' }, { idempotencyKey: 'a' });
    const b = command(s, 'fence.step', { tag: 'b' }, { idempotencyKey: 'b', after: 'a' });

    expect(errorOf(await a).code).to.equal('deadline_exceeded');
    expect(errorOf(await b)).to.deep.include({ code: 'unavailable', retryable: true, details: { after: 'a' } });

    fenceGate.open();
    await waitFor(() => fenceLog.includes('a:end'));
    await delay(20);

    expect(resultOf(await command(s, 'fence.step', { tag: 'b' }, { idempotencyKey: 'b', after: 'a' }))).to.equal('b');
    expect(resultOf(await command(s, 'fence.hang', { tag: 'a' }, { idempotencyKey: 'a' }))).to.equal('a');
    expect(fenceLog).to.deep.equal(['a', 'a:end', 'b']);
  });

  it('keeps a resend that joined during the abort grace waiting past the cut-loose, and answers it the late result', async () => {
    const first = await connect('fence-grace', { http: { socket: { ordering: { abortGraceMs: 200 } } } });
    void command(first, 'fence.wait', { tag: 'a' }, { idempotencyKey: 'a' }).catch(() => undefined);
    await waitFor(() => fenceLog.includes('a'));
    first.close();
    await delay(50);

    const second = await connect('fence-grace');
    const resent = command(second, 'fence.wait', { tag: 'a' }, { idempotencyKey: 'a' });
    // the grace ends while the resend is joined to the hung run
    await delay(400);
    expect(fenceLog).to.deep.equal(['a']);

    fenceGate.open();
    expect(resultOf(await resent)).to.equal('a');
    expect(fenceLog).to.deep.equal(['a', 'a:end']);
  });

  it('cuts loose a handler a disconnect aborted while it ran, skips its successor aborted while queued, and runs each once', async () => {
    const first = await connect('fence-drop', { http: { socket: { ordering: { abortGraceMs: 200 } } } });
    void command(first, 'fence.wait', { tag: 'a' }, { idempotencyKey: 'a' }).catch(() => undefined);
    void command(first, 'fence.step', { tag: 'b' }, { idempotencyKey: 'b', after: 'a' }).catch(() => undefined);
    await waitFor(() => fenceLog.includes('a'));
    await delay(20);
    first.close();
    // past the grace: a is cut loose, and b, aborted while it waited, never started
    await delay(300);
    expect(fenceLog).to.deep.equal(['a']);

    const second = await connect('fence-drop');
    expect(errorOf(await command(second, 'fence.step', { tag: 'b' }, { idempotencyKey: 'b', after: 'a' }))).to.deep.include({ code: 'unavailable', details: { after: 'a' } });

    fenceGate.open();
    await waitFor(() => fenceLog.includes('a:end'));
    await delay(20);

    expect(resultOf(await command(second, 'fence.wait', { tag: 'a' }, { idempotencyKey: 'a' }))).to.equal('a');
    expect(resultOf(await command(second, 'fence.step', { tag: 'b' }, { idempotencyKey: 'b', after: 'a' }))).to.equal('b');
    expect(fenceLog).to.deep.equal(['a', 'a:end', 'b']);
  });

  it('holds a successor sent on a second connection of the client until the predecessor on the first completes', async () => {
    const first = await connect('fence-two');
    const second = await connect('fence-two');
    const a = command(first, 'fence.wait', { tag: 'a' }, { idempotencyKey: 'a' });
    await waitFor(() => fenceLog.includes('a'));

    const b = command(second, 'fence.step', { tag: 'b' }, { idempotencyKey: 'b', after: 'a' });
    await delay(100);
    expect(fenceLog).to.deep.equal(['a']);

    fenceGate.open();
    expect([resultOf(await a), resultOf(await b)]).to.deep.equal(['a', 'b']);
    expect(fenceLog).to.deep.equal(['a', 'a:end', 'b']);
  });

  it("looks the predecessor up under the sender's principal, so another principal with the same clientId cannot pass the fence", async () => {
    const alice = await connect('fence-shared', undefined, 'good');
    expect(resultOf(await command(alice, 'fence.step', { tag: 'a' }, { idempotencyKey: 'a' }))).to.equal('a');

    const anonymous = await connect('fence-shared');
    expect(errorOf(await command(anonymous, 'fence.step', { tag: 'b' }, { idempotencyKey: 'b', after: 'a' }))).to.deep.include({ code: 'unavailable', details: { after: 'a' } });

    expect(resultOf(await command(alice, 'fence.step', { tag: 'b' }, { idempotencyKey: 'b', after: 'a' }))).to.equal('b');
    expect(fenceLog).to.deep.equal(['a', 'b']);
  });

  it('never runs a cut-loose handler twice when its key is resent after a drop', async () => {
    const first = await connect('fence-twice', { http: { socket: { ordering: { abortGraceMs: 100 } } } });
    expect(errorOf(await command(first, 'fence.hang', { tag: 'a' }, { idempotencyKey: 'a' })).code).to.equal('deadline_exceeded');
    // past the grace: the queue place is cut loose while the handler still hangs
    await delay(200);

    expect(killConnections(t)).to.equal(1);
    const second = await connect('fence-twice');

    // joins the hung run until its own deadline instead of starting the handler again
    expect(errorOf(await command(second, 'fence.hang', { tag: 'a' }, { idempotencyKey: 'a' })).code).to.equal('deadline_exceeded');
    expect(fenceLog).to.deep.equal(['a']);

    fenceGate.open();
    await waitFor(() => fenceLog.includes('a:end'));
    await delay(20);

    expect(resultOf(await command(second, 'fence.hang', { tag: 'a' }, { idempotencyKey: 'a' }))).to.equal('a');
    expect(fenceLog).to.deep.equal(['a', 'a:end']);
  });

  // a final not_found or forbidden would be stored, and the durable queue would fail the edit for good
  it('hydrates a pipelined command only after its predecessor ran, so an edit right behind a create finds the document', async () => {
    const s = await connect('fence-hydrate');
    const [a, b] = await Promise.all([command(s, 'fence.create', { id: 'd1', ms: 100 }, { idempotencyKey: 'a' }), command(s, 'fence.edit', { id: 'd1' }, { idempotencyKey: 'b', after: 'a' })]);

    expect([resultOf(a), resultOf(b)]).to.deep.equal(['d1', 'd1']);
    expect(fenceLog).to.deep.equal(['create:d1', 'edit:d1']);
  });

  it('checks the policies of a pipelined command only after its predecessor ran', async () => {
    const s = await connect('fence-policy');
    const [a, b] = await Promise.all([command(s, 'fence.create', { id: 'd2', ms: 100 }, { idempotencyKey: 'a' }), command(s, 'fence.rename', { id: 'd2' }, { idempotencyKey: 'b', after: 'a' })]);

    expect([resultOf(a), resultOf(b)]).to.deep.equal(['d2', 'd2']);
    expect(fenceLog).to.deep.equal(['create:d2', 'rename:d2']);
  });

  it("refuses after on a command that is not ordered: 'client'", async () => {
    const s = await connect('fence-unordered');
    const error = errorOf(await command(s, 'fence.loose', undefined, { idempotencyKey: 'k', after: 'a' }));

    expect(error.code).to.equal('failed_precondition');
    expect(fenceLog).to.deep.equal([]);
  });
});
