import 'mocha';
import { expect } from 'chai';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import ts from 'typescript';
import { generateClientFiles } from '../src/index.js';
import { appBasicManifest } from './support/fixture.js';

interface ChatMessage {
  id: string;
  text: string;
}

type Listener = (payload: unknown) => void;

interface StreamState {
  items: unknown[];
  status: string;
  error: unknown;
}

interface SocketModule {
  useChatMessageEvent(socket: FakeSocket, listener: Listener): void;
  useChatHistoryStream(socket: FakeSocket, payload: { since: string } | null): StreamState;
}

interface SwrSocketModule {
  useChatMessageLatest(socket: FakeSocket): { data?: unknown };
}

class FakeStream implements AsyncIterator<unknown> {
  public returned = 0;
  private readonly buffer: IteratorResult<unknown>[] = [];
  private failure: Error | undefined;
  private reader: { resolve(r: IteratorResult<unknown>): void; reject(e: Error): void } | undefined;

  constructor(public readonly payload: unknown) {}

  public next(): Promise<IteratorResult<unknown>> {
    const ready = this.buffer.shift();
    if (ready) return Promise.resolve(ready);
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => (this.reader = { resolve, reject }));
  }

  public return(): Promise<IteratorResult<unknown>> {
    this.returned++;
    this.settle({ value: undefined, done: true });
    return Promise.resolve({ value: undefined, done: true });
  }

  public push(value: unknown): void {
    this.settle({ value, done: false });
  }

  public end(): void {
    this.settle({ value: undefined, done: true });
  }

  public fail(error: Error): void {
    const reader = this.reader;
    this.reader = undefined;
    if (reader) reader.reject(error);
    else this.failure = error;
  }

  private settle(result: IteratorResult<unknown>): void {
    const reader = this.reader;
    this.reader = undefined;
    if (reader) reader.resolve(result);
    else this.buffer.push(result);
  }
}

/** The part of `TypedSocketClient` the hooks call: `on` with an unsubscribe, and `stream`. */
class FakeSocket {
  public subscriptions = 0;
  public readonly streams: FakeStream[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  public on(event: string, listener: Listener): () => void {
    this.subscriptions++;
    const set = this.listeners.get(event) ?? new Set<Listener>();
    this.listeners.set(event, set.add(listener));
    return () => set.delete(listener);
  }

  public stream(name: string, payload: unknown): FakeStream {
    expect(name).to.equal('history');
    const stream = new FakeStream(payload);
    this.streams.push(stream);
    return stream;
  }

  public listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  public emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function step(action: () => void = () => undefined): Promise<void> {
  await act(async () => {
    action();
    await settle();
  });
}

interface Mounted<P, R> {
  result(): R;
  rerender(props: P): Promise<void>;
  unmount(): Promise<void>;
}

async function mount<P extends object, R>(hook: (props: P) => R, props: P): Promise<Mounted<P, R>> {
  let result: R | undefined;
  const Probe = (p: P) => {
    result = hook(p);
    return null;
  };
  let renderer: ReactTestRenderer | undefined;
  await step(() => (renderer = TestRenderer.create(createElement(Probe, props))));
  const current = () => {
    if (!renderer) throw new Error('not mounted');
    return renderer;
  };
  return {
    result: () => result as R,
    rerender: (next) => step(() => current().update(createElement(Probe, next))),
    unmount: () => step(() => current().unmount()),
  };
}

// The generated files import only `react` and `swr/subscription` at runtime; every other import is type-only.
async function loadGenerated(files: Record<string, string>, dir: string): Promise<{ socket: SocketModule; swr: SwrSocketModule }> {
  const resolved: Record<string, string> = { react: import.meta.resolve('react'), 'swr/subscription': import.meta.resolve('swr/subscription') };
  const write = (name: string) => {
    const { outputText } = ts.transpileModule(files[name], { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    const file = join(dir, name.replace(/\.ts$/, '.mjs'));
    writeFileSync(file, outputText.replace(/from '([^']+)'/g, (whole, specifier: string) => (resolved[specifier] ? `from '${resolved[specifier]}'` : whole)));
    return pathToFileURL(file).href;
  };
  return {
    socket: (await import(write('client.socket.ts'))) as SocketModule,
    swr: (await import(write('client.socket-swr.ts'))) as SwrSocketModule,
  };
}

describe('socket hooks at runtime', () => {
  let dir: string;
  let socketHooks: SocketModule;
  let swrHooks: SwrSocketModule;
  const message: ChatMessage = { id: 'm1', text: 'hello' };

  const flags = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; IS_REACT_NATIVE_TEST_ENVIRONMENT?: boolean };

  before(async () => {
    flags.IS_REACT_ACT_ENVIRONMENT = true;
    // react-test-renderer logs its deprecation on every create() unless this is set; it is still the one React renderer that needs no DOM.
    flags.IS_REACT_NATIVE_TEST_ENVIRONMENT = true;
    const files = await generateClientFiles({ manifest: await appBasicManifest(), hooks: ['swr'], socketHooks: true });
    dir = mkdtempSync(join(tmpdir(), 'client-socket-hooks-'));
    ({ socket: socketHooks, swr: swrHooks } = await loadGenerated(Object.fromEntries(files.map((f) => [f.path, f.contents])), dir));
  });

  after(() => {
    delete flags.IS_REACT_ACT_ENVIRONMENT;
    delete flags.IS_REACT_NATIVE_TEST_ENVIRONMENT;
    rmSync(dir, { recursive: true, force: true });
  });

  describe('event hook', () => {
    it('subscribes on mount and removes the subscription on unmount', async () => {
      const socket = new FakeSocket();
      const received: unknown[] = [];
      const view = await mount((p: { listener: Listener }) => socketHooks.useChatMessageEvent(socket, p.listener), { listener: (m) => received.push(m) });
      expect([socket.subscriptions, socket.listenerCount('message')]).to.deep.equal([1, 1]);
      await step(() => socket.emit('message', message));
      expect(received).to.deep.equal([message]);
      await view.unmount();
      expect(socket.listenerCount('message')).to.equal(0);
    });

    it('calls the latest listener after a re-render without subscribing again', async () => {
      const socket = new FakeSocket();
      const first: unknown[] = [];
      const second: unknown[] = [];
      const view = await mount((p: { listener: Listener }) => socketHooks.useChatMessageEvent(socket, p.listener), { listener: (m) => first.push(m) });
      await view.rerender({ listener: (m) => second.push(m) });
      await step(() => socket.emit('message', message));
      expect([first, second, socket.subscriptions]).to.deep.equal([[], [message], 1]);
      await view.unmount();
    });

    it('moves the subscription to a new socket', async () => {
      const [a, b] = [new FakeSocket(), new FakeSocket()];
      const view = await mount((p: { socket: FakeSocket }) => socketHooks.useChatMessageEvent(p.socket, () => undefined), { socket: a });
      await view.rerender({ socket: b });
      expect([a.listenerCount('message'), b.listenerCount('message')]).to.deep.equal([0, 1]);
      await view.unmount();
    });
  });

  describe('stream hook', () => {
    type Props = { payload: { since: string } | null };
    const mountStream = (socket: FakeSocket, payload: Props['payload']) => mount<Props, StreamState>((p) => socketHooks.useChatHistoryStream(socket, p.payload), { payload });

    it('opens nothing for a null payload', async () => {
      const socket = new FakeSocket();
      const view = await mountStream(socket, null);
      expect([socket.streams.length, view.result()]).to.deep.equal([0, { items: [], status: 'idle', error: undefined }]);
      await view.unmount();
    });

    it('accumulates items into state, keeps one stream for an equal payload object and cancels the iterator on unmount', async () => {
      const socket = new FakeSocket();
      const view = await mountStream(socket, { since: 'a' });
      const [stream] = socket.streams;
      expect(stream.payload).to.deep.equal({ since: 'a' });
      await step(() => {
        stream.push({ id: '1', text: 'x' });
        stream.push({ id: '2', text: 'y' });
      });
      await view.rerender({ payload: { since: 'a' } });
      expect(socket.streams).to.have.length(1);
      expect(view.result()).to.deep.equal({ items: [{ id: '1', text: 'x' }, { id: '2', text: 'y' }], status: 'streaming', error: undefined });
      await view.unmount();
      expect(stream.returned).to.equal(1);
    });

    it('cancels the old stream and starts over with no items when the payload changes', async () => {
      const socket = new FakeSocket();
      const view = await mountStream(socket, { since: 'a' });
      await step(() => socket.streams[0].push({ id: '1', text: 'x' }));
      await view.rerender({ payload: { since: 'b' } });
      expect(socket.streams.map((s) => [s.payload, s.returned])).to.deep.equal([[{ since: 'a' }, 1], [{ since: 'b' }, 0]]);
      expect(view.result()).to.deep.equal({ items: [], status: 'streaming', error: undefined });
      await view.rerender({ payload: null });
      expect([socket.streams[1].returned, view.result().status]).to.deep.equal([1, 'idle']);
      await view.unmount();
    });

    it('reports the end of the stream and a failure', async () => {
      const socket = new FakeSocket();
      const ended = await mountStream(socket, { since: 'a' });
      await step(() => socket.streams[0].end());
      expect(ended.result().status).to.equal('done');
      await ended.unmount();
      const failed = await mountStream(socket, { since: 'a' });
      const error = new Error('stream failed');
      await step(() => {
        socket.streams[1].push({ id: '1', text: 'x' });
        socket.streams[1].fail(error);
      });
      expect(failed.result()).to.deep.equal({ items: [{ id: '1', text: 'x' }], status: 'error', error });
      await failed.unmount();
    });
  });

  describe('SWR latest hook', () => {
    it('holds the latest payload of the event and unsubscribes on unmount', async () => {
      const socket = new FakeSocket();
      const view = await mount(() => swrHooks.useChatMessageLatest(socket), {});
      expect([view.result().data, socket.listenerCount('message')]).to.deep.equal([undefined, 1]);
      await step(() => socket.emit('message', message));
      await step(() => socket.emit('message', { id: 'm2', text: 'again' }));
      expect(view.result().data).to.deep.equal({ id: 'm2', text: 'again' });
      await view.unmount();
      expect(socket.listenerCount('message')).to.equal(0);
    });
  });
});
