import 'mocha';
import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import { SocketClient } from '@spinajs/http-socket-client';
import { act, createElement, Fragment, StrictMode, useLayoutEffect, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SWRConfig, type Cache } from 'swr';
import { generateClientFiles } from '../src/index.js';
import { appBasicManifest } from './support/fixture.js';
import { writeModules, type ModuleDir } from './support/modules.js';

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
  useChatMessageLatest(socket: FakeSocket | SocketClient): { data?: unknown };
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
  /** Every render's props and hook result, in order. */
  renders: { props: P; result: R }[];
  rerender(props: P): Promise<void>;
  unmount(): Promise<void>;
}

type Wrap = (element: ReactElement) => ReactElement;

const strict: Wrap = (element) => createElement(StrictMode, null, element);

async function mount<P extends object, R>(hook: (props: P) => R, props: P, wrap: Wrap = (element) => element): Promise<Mounted<P, R>> {
  const renders: { props: P; result: R }[] = [];
  const Probe = (p: P) => {
    renders.push({ props: p, result: hook(p) });
    return null;
  };
  const root = await render(wrap(createElement(Probe, props)));
  return {
    result: () => renders[renders.length - 1].result,
    renders,
    rerender: (next) => step(() => root.render(wrap(createElement(Probe, next)))),
    unmount: () => step(() => root.unmount()),
  };
}

async function render(element: ReactElement): Promise<Root> {
  const root = createRoot(document.createElement('div'));
  await step(() => root.render(element));
  return root;
}

const GLOBALS = ['window', 'document', 'navigator'] as const;

describe('socket hooks at runtime', () => {
  let modules: ModuleDir | undefined;
  let dom: JSDOM;
  let saved: Partial<Record<(typeof GLOBALS)[number], PropertyDescriptor>>;
  let socketHooks: SocketModule;
  let swrHooks: SwrSocketModule;
  const message: ChatMessage = { id: 'm1', text: 'hello' };
  const flags = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };

  // The generator runs first: with `window` defined, its schema tooling takes the browser path.
  before(async () => {
    const files = await generateClientFiles({ manifest: await appBasicManifest(), hooks: ['swr'], socketHooks: true });
    // `window` must exist before the generated files load: it picks useLayoutEffect for the listener ref.
    dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
    saved = Object.fromEntries(GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    for (const name of GLOBALS) Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true });
    flags.IS_REACT_ACT_ENVIRONMENT = true;
    const generated = Object.fromEntries(files.filter((f) => f.path.startsWith('client.socket')).map((f) => [f.path, f.contents]));
    modules = writeModules(generated, { react: import.meta.resolve('react'), 'swr/subscription': import.meta.resolve('swr/subscription') });
    [socketHooks, swrHooks] = await Promise.all([modules.import<SocketModule>('client.socket.js'), modules.import<SwrSocketModule>('client.socket-swr.js')]);
  });

  after(() => {
    modules?.remove();
    delete flags.IS_REACT_ACT_ENVIRONMENT;
    for (const name of GLOBALS) {
      const descriptor = saved[name];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
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

    it('keeps one live subscription under StrictMode and calls the latest listener', async () => {
      const socket = new FakeSocket();
      const second: unknown[] = [];
      const view = await mount<{ listener: Listener }, void>((p) => socketHooks.useChatMessageEvent(socket, p.listener), { listener: () => undefined }, strict);
      await view.rerender({ listener: (m) => second.push(m) });
      await step(() => socket.emit('message', message));
      expect([socket.listenerCount('message'), second]).to.deep.equal([1, [message]]);
      await view.unmount();
      expect(socket.listenerCount('message')).to.equal(0);
    });

    it('updates the listener in the commit, before a sibling layout effect emits', async () => {
      const socket = new FakeSocket();
      const received: string[] = [];
      const Probe = (p: { name: string }) => {
        socketHooks.useChatMessageEvent(socket, () => received.push(p.name));
        return null;
      };
      const Emitter = (p: { tick: number }) => {
        useLayoutEffect(() => {
          if (p.tick > 0) socket.emit('message', message);
        }, [p.tick]);
        return null;
      };
      const tree = (name: string, tick: number) => createElement(Fragment, null, createElement(Probe, { name }), createElement(Emitter, { tick }));
      const root = await render(tree('first', 0));
      await step(() => root.render(tree('second', 1)));
      expect(received).to.deep.equal(['second']);
      await step(() => root.unmount());
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

    // A render must never show one payload's items, or a running stream, under another payload.
    function expectEveryRenderMatchesItsPayload(renders: { props: Props; result: StreamState }[]): void {
      for (const { props, result } of renders) {
        const label = JSON.stringify([props.payload, result]);
        if (props.payload === null) {
          expect(result, label).to.deep.equal({ items: [], status: 'idle', error: undefined });
          continue;
        }
        const since = props.payload.since;
        expect(result.status, label).to.not.equal('idle');
        expect((result.items as ChatMessage[]).every((item) => item.id.startsWith(since)), label).to.equal(true);
      }
    }

    it('renders no stale items or status for a new payload, in any render', async () => {
      const socket = new FakeSocket();
      const view = await mountStream(socket, { since: 'a' });
      expect(view.renders[0].result).to.deep.equal({ items: [], status: 'streaming', error: undefined });
      await step(() => socket.streams[0].push({ id: 'a1', text: 'x' }));
      await view.rerender({ payload: { since: 'b' } });
      await step(() => socket.streams[1].push({ id: 'b1', text: 'y' }));
      await view.rerender({ payload: null });
      await view.rerender({ payload: { since: 'c' } });
      expectEveryRenderMatchesItsPayload(view.renders);
      expect(view.renders.flatMap((r) => (r.result.items as ChatMessage[]).map((i) => i.id))).to.include.members(['a1', 'b1']);
      await view.unmount();
    });

    it('keeps one live stream under StrictMode and cancels it on unmount', async () => {
      const socket = new FakeSocket();
      const view = await mount<Props, StreamState>((p) => socketHooks.useChatHistoryStream(socket, p.payload), { payload: { since: 'a' } }, strict);
      const live = () => socket.streams.filter((st) => st.returned === 0);
      expect(live()).to.have.length(1);
      await step(() => live()[0].push({ id: 'a1', text: 'x' }));
      expect(view.result().items).to.deep.equal([{ id: 'a1', text: 'x' }]);
      expectEveryRenderMatchesItsPayload(view.renders);
      await view.unmount();
      expect(live()).to.have.length(0);
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
      const view = await mount(() => ({ data: swrHooks.useChatMessageLatest(socket).data }), {});
      expect([view.result().data, socket.listenerCount('message')]).to.deep.equal([undefined, 1]);
      await step(() => socket.emit('message', message));
      await step(() => socket.emit('message', { id: 'm2', text: 'again' }));
      expect(view.result().data).to.deep.equal({ id: 'm2', text: 'again' });
      await view.unmount();
      expect(socket.listenerCount('message')).to.equal(0);
    });

    it('shares one subscription between two components on one socket, and keeps two sockets apart', async () => {
      const sockets = { a: new FakeSocket(), b: new FakeSocket() };
      const results: Record<string, { data?: unknown }> = {};
      const Probe = (p: { name: string; socket: 'a' | 'b' }) => {
        // SWR re-renders a component only for the fields it read during render.
        results[p.name] = { data: swrHooks.useChatMessageLatest(sockets[p.socket]).data };
        return null;
      };
      const tree = createElement(StrictMode, null, createElement(Probe, { name: 'one', socket: 'a' }), createElement(Probe, { name: 'two', socket: 'a' }), createElement(Probe, { name: 'three', socket: 'b' }));
      const root = await render(tree);
      const counts = () => [sockets.a.listenerCount('message'), sockets.b.listenerCount('message')];
      expect(counts()).to.deep.equal([1, 1]);
      await step(() => sockets.a.emit('message', message));
      expect([results.one.data, results.two.data, results.three.data]).to.deep.equal([message, message, undefined]);
      await step(() => root.unmount());
      expect(counts()).to.deep.equal([0, 0]);
    });

    it('keys the subscription by a socket id, never by what the socket holds', async () => {
      const cache: Cache = new Map();
      const socket = new SocketClient({ url: 'http://socket.example', autoConnect: false, io: { extraHeaders: { authorization: 'Bearer SECRET-TOKEN' } } });
      try {
        const view = await mount(() => ({ data: swrHooks.useChatMessageLatest(socket).data }), {}, (element) => createElement(SWRConfig, { value: { provider: () => cache } }, element));
        const keys = [...cache.keys()];
        expect(keys).to.have.length.greaterThan(0);
        for (const key of keys) {
          expect(key).to.not.include('SECRET-TOKEN');
          expect(key).to.not.include('socket.example');
          expect(key).to.not.include(socket.clientId);
          expect(key.length).to.be.lessThan(100);
        }
        await view.unmount();
      } finally {
        await socket.close();
      }
    });
  });
});
