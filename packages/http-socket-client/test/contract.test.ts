import 'mocha';
import { expect } from 'chai';
import { defineContract } from '@spinajs/http-socket-common';
import type { TypedSocketClient } from '../src/contract.js';
import { closeAll } from './support/cleanup.js';
import { makeClient, statefulClient } from './support/client.js';
import { StubServer } from './support/stub-server.js';
import { until, waitForState } from './support/wait.js';

type DocsContract = {
  commands: {
    'docs.open': [{ id: string }, { title: string }];
    'docs.touch': [{ id: string }, void];
    'docs.snapshot': [{ id: string }, AsyncIterable<{ part: number }>];
  };
  events: {
    'docs.committed': { rev: number };
  };
  clientEvents: {
    'docs.cursor': { x: number };
  };
};

const Docs = defineContract<DocsContract>();

describe('typed contracts', () => {
  let server: StubServer;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
  });

  afterEach(async () => {
    closeAll();
    await server.stop();
  });

  it('typed() returns the same client with contract-checked commands and events', async () => {
    server.handlers.set('docs.open', (payload: { id: string }) => ({ title: `doc ${payload.id}` }));
    const client = makeClient(server);
    const api = client.typed(Docs);
    expect(api).to.equal(client);
    await waitForState(statefulClient(client), 'online');

    const opened = await api.command('docs.open', { id: '7' });
    const revisions: number[] = [];
    api.on('docs.committed', (event) => revisions.push(event.rev));
    server.emitEvent('docs.committed', { rev: 3 });
    await until(() => revisions.length === 1);

    expect(opened.title).to.equal('doc 7');
    expect(revisions).to.deep.equal([3]);
    expect(api.emit('docs.cursor', { x: 1 })).to.equal(true);
  });
});

// Compile-time only; `npm run typecheck` fails if an expectation below stops holding.
function typeChecks(api: TypedSocketClient<DocsContract>): void {
  // @ts-expect-error unknown command name
  void api.command('docs.nope', {});
  // @ts-expect-error payload of the wrong shape
  void api.command('docs.open', { id: 7 });
  const opened: Promise<{ title: string }> = api.command('docs.open', { id: '1' });
  const touched: Promise<void> = api.command('docs.touch', { id: '1' });
  const parts: AsyncIterable<{ part: number }> = api.stream('docs.snapshot', { id: '1' });
  // @ts-expect-error stream items of the wrong type
  const badItems: AsyncIterable<string> = api.stream('docs.snapshot', { id: '1' });
  // @ts-expect-error stream payload of the wrong shape
  void api.stream('docs.snapshot', { id: 1 });
  // @ts-expect-error credits must be a number
  void api.stream('docs.snapshot', { id: '1' }, { credits: 'x' });
  // @ts-expect-error unknown command name
  void api.stream('docs.nope', {});
  // @ts-expect-error unknown event name
  api.on('docs.nope', () => undefined);
  api.on('docs.committed', (event) => {
    const rev: number = event.rev;
    void rev;
  });
  // @ts-expect-error wrong event payload
  api.emit('docs.cursor', { x: 'left' });
  // @ts-expect-error a server event cannot be emitted by the client
  api.emit('docs.committed', { rev: 1 });
  // @ts-expect-error a client event is never received
  api.on('docs.cursor', () => undefined);
  api.on('state', (state) => {
    const known: 'connecting' | 'online' | 'offline' | 'closed' = state;
    void known;
  });
  void [opened, touched, parts, badItems];
}
void typeChecks;
