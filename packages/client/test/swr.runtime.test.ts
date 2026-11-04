import 'mocha';
import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { createElement, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { generateClientFiles } from '../src/index.js';
import { appBasicManifest } from './support/fixture.js';
import { loadSwrHooks, setProbeClient, type LoadedSwr, type MutationConfig, type ProbeClient, type SwrPackage, type Trigger } from './support/swr-runtime.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, what: string, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

// For "nothing else happens": returns once the counts have not moved for a whole quiet period.
async function quiet(counts: Counts, period = 80): Promise<void> {
  let last = JSON.stringify(counts);
  let since = Date.now();
  while (Date.now() - since < period) {
    await sleep(10);
    const now = JSON.stringify(counts);
    if (now !== last) {
      last = now;
      since = Date.now();
    }
  }
}

const GLOBALS = ['window', 'document', 'navigator'] as const;

type Counts = Record<string, number>;

interface Control {
  counts: Counts;
  failCreate: boolean;
}

function probeClient(control: Control, delay = 0): ProbeClient {
  const { counts } = control;
  const hit = async (name: string, value: (n: number) => unknown) => {
    counts[name] = (counts[name] ?? 0) + 1;
    await sleep(delay);
    return value(counts[name]);
  };
  return {
    users: {
      get: (id) => hit(`users.get:${id}`, (n) => ({ id, version: n })),
      list: () => hit('users.list', (n) => ({ version: n })),
      create: (body) => (control.failCreate ? Promise.reject(new TypeError('fetch failed')) : hit('users.create', () => ({ created: body }))),
    },
    articles: { read: (id) => hit(`articles.read:${id}`, (n) => ({ id, version: n })) },
    health: { get: () => hit('health.get', () => ({ ok: true })) },
  };
}

const newControl = (): Control => ({ counts: {}, failCreate: false });

// The generated hooks run against SWR's real cache: the floor of the peer range and the latest installed copy.
const PACKAGES: [string, SwrPackage][] = [
  ['the peer floor (2.2.0)', 'swr-floor'],
  ['the latest installed swr', 'swr'],
];

for (const [label, swrPackage] of PACKAGES) {
  describe(`SWR hooks at runtime against ${label}`, () => {
    let loaded: LoadedSwr;
    let dom: JSDOM;
    let root: Root | undefined;
    let saved: Partial<Record<(typeof GLOBALS)[number], PropertyDescriptor>>;

    before(async () => {
      const generated = await generateClientFiles({ manifest: await appBasicManifest(), hooks: ['swr'] });
      dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
      saved = Object.fromEntries(GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
      for (const name of GLOBALS) Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true });
      loaded = await loadSwrHooks(Object.fromEntries(generated.map((f) => [f.path, f.contents])), swrPackage);
    });

    after(() => {
      for (const name of GLOBALS) {
        const descriptor = saved[name];
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      dom.window.close();
    });

    afterEach(() => {
      root?.unmount();
      root = undefined;
    });

    const swrConfig = (children: ReactNode, extra: object = {}) =>
      createElement(loaded.swr.SWRConfig as ComponentType<{ value: object; children?: ReactNode }>, { value: { provider: () => new Map(), dedupingInterval: 0, revalidateOnFocus: false, errorRetryCount: 0, ...extra } }, children);

    async function mount(probe: () => void): Promise<() => Promise<void>> {
      root = createRoot(dom.window.document.getElementById('root') as HTMLElement);
      const Probe = () => {
        probe();
        return null;
      };
      const render = async () => {
        root?.render(swrConfig(createElement(Probe)));
        await sleep(0);
      };
      await render();
      return render;
    }

    interface Mounted {
      control: Control;
      create: Trigger;
      seen: Record<string, unknown>;
    }

    async function mountAll(createConfig?: MutationConfig, delay = 0): Promise<Mounted> {
      const control = newControl();
      setProbeClient(probeClient(control, delay));
      const seen: Record<string, unknown> = {};
      const { hooks, swr } = loaded;
      let create: Trigger | undefined;
      await mount(() => {
        seen.user1 = hooks.useUsersGet({ id: 1 }).data;
        seen.user2 = hooks.useUsersGet({ id: 2 }).data;
        seen.list = hooks.useUsersList({ query: {} }).data;
        seen.article = hooks.useArticlesRead({ id: 1 }).data;
        seen.health = hooks.useHealthGet().data;
        // Starts like a users key, but is another controller: a prefix match must not reach it.
        seen.lookalike = swr.default(['spinajs', 'usersAdmin', 'get', {}], () => {
          control.counts.lookalike = (control.counts.lookalike ?? 0) + 1;
          return 'x';
        }).data;
        create = hooks.useUsersCreate(createConfig);
      });
      await waitFor(() => Object.keys(control.counts).length === 6, 'the first fetches');
      await quiet(control.counts);
      return { control, create: create as Trigger, seen };
    }

    const refetched = (before: Counts, after: Counts) => Object.keys(after).filter((k) => (after[k] ?? 0) > (before[k] ?? 0)).sort();

    it('fetches only for variables, and nothing for a null variables argument', async () => {
      const control = newControl();
      setProbeClient(probeClient(control));
      const seen: Record<string, unknown> = {};
      let id: number | null = null;
      const render = await mount(() => {
        seen.user = loaded.hooks.useUsersGet(id === null ? null : { id }).data;
        seen.health = loaded.hooks.useHealthGet(null).data;
      });
      await quiet(control.counts);
      expect(control.counts).to.deep.equal({});
      expect(seen).to.deep.equal({ user: undefined, health: undefined });
      id = 9;
      await render();
      await waitFor(() => seen.user !== undefined, 'the fetch for the variables');
      expect(control.counts).to.deep.equal({ 'users.get:9': 1 });
      expect(seen.user).to.deep.equal({ id: 9, version: 1 });
    });

    it('revalidates every key of the mutation controller by default, and no key of another controller', async () => {
      const state = await mountAll();
      expect(state.control.counts).to.deep.equal({ 'users.get:1': 1, 'users.get:2': 1, 'users.list': 1, 'articles.read:1': 1, 'health.get': 1, lookalike: 1 });
      const before = { ...state.control.counts };
      await state.create.trigger({ body: { email: 'a@b.c' } });
      await quiet(state.control.counts);
      expect(refetched(before, state.control.counts)).to.deep.equal(['users.create', 'users.get:1', 'users.get:2', 'users.list']);
      expect(state.seen.user1).to.deep.equal({ id: 1, version: 2 });
      expect(state.seen.article).to.deep.equal({ id: 1, version: 1 });
    });

    it('keeps the mutation pending until the refetch of the controller settles', async () => {
      const state = await mountAll(undefined, 30);
      const before = { ...state.control.counts };
      await state.create.trigger({ body: {} });
      expect(refetched(before, state.control.counts)).to.deep.equal(['users.create', 'users.get:1', 'users.get:2', 'users.list']);
      expect(state.seen.list).to.deep.equal({ version: 2 });
    });

    it('revalidates nothing with invalidate: false', async () => {
      const state = await mountAll({ invalidate: false });
      const before = { ...state.control.counts };
      await state.create.trigger({ body: {} });
      await quiet(state.control.counts);
      expect(refetched(before, state.control.counts)).to.deep.equal(['users.create']);
    });

    it('revalidates the keys under a full key given in invalidate, variables included', async () => {
      const state = await mountAll({ invalidate: [loaded.appKeys.users.get({ id: 1 })] });
      const before = { ...state.control.counts };
      await state.create.trigger({ body: {} });
      await quiet(state.control.counts);
      expect(refetched(before, state.control.counts)).to.deep.equal(['users.create', 'users.get:1']);
    });

    it('refetches a key once however many of the prefixes given contain it', async () => {
      const users = loaded.appKeys.users;
      const state = await mountAll({ invalidate: [users.all, users.get({ id: 1 }), users.all] });
      const before = { ...state.control.counts };
      await state.create.trigger({ body: {} });
      await quiet(state.control.counts);
      expect(Object.fromEntries(Object.entries(state.control.counts).map(([k, n]) => [k, n - (before[k] ?? 0)]))).to.deep.equal({
        'users.get:1': 1,
        'users.get:2': 1,
        'users.list': 1,
        'users.create': 1,
        'articles.read:1': 0,
        'health.get': 0,
        lookalike: 0,
      });
    });

    it('replaces the default with the prefixes given, which may belong to another controller', async () => {
      const state = await mountAll({ invalidate: [loaded.appKeys.articles.all] });
      const before = { ...state.control.counts };
      await state.create.trigger({ body: {} });
      await quiet(state.control.counts);
      expect(refetched(before, state.control.counts)).to.deep.equal(['articles.read:1', 'users.create']);
    });

    it('calls the onSuccess of the caller with the reply, and revalidates nothing when the call fails', async () => {
      const replies: unknown[] = [];
      const state = await mountAll({ onSuccess: (data) => replies.push(data) });
      await state.create.trigger({ body: { email: 'x' } });
      expect(replies).to.deep.equal([{ created: { email: 'x' } }]);

      state.control.failCreate = true;
      const before = { ...state.control.counts };
      const error = await state.create.trigger({ body: {} }).then(
        () => undefined,
        (e: unknown) => e,
      );
      await quiet(state.control.counts);
      expect(error).to.be.instanceOf(TypeError);
      expect(refetched(before, state.control.counts)).to.deep.equal([]);
      expect(replies).to.have.length(1);
    });

    it('hydrates from a fallback keyed by unstable_serialize of the key, and not by the key array itself', () => {
      setProbeClient(probeClient(newControl()));
      const key = loaded.appKeys.users.get({ id: 7 });
      // React 18 warns that layout effects do nothing on the server, because jsdom defines `window`.
      const quietly = <T>(run: () => T): T => {
        const { error } = console;
        console.error = () => undefined;
        try {
          return run();
        } finally {
          console.error = error;
        }
      };
      const render = (fallback: Record<string, unknown>) => quietly(() => renderToString(swrConfig(createElement(() => JSON.stringify(loaded.hooks.useUsersGet({ id: 7 }).data ?? null)), { fallback })));
      expect(render({ [loaded.swr.unstable_serialize(key)]: { id: 7, email: 'seed' } })).to.include('seed');
      expect(render({ [String(key)]: { id: 7, email: 'seed' } })).to.not.include('seed');
    });

    it('loads one copy of React for the hooks, SWR and react-dom', () => {
      const require = createRequire(import.meta.url);
      const from = (pkg: string) => require.resolve('react', { paths: [dirname(require.resolve(`${pkg}/package.json`))] });
      const copies = new Set(['react-dom', swrPackage, 'use-sync-external-store'].map(from));
      expect([...copies]).to.have.length(1);
      expect(from('react-dom')).to.equal(require.resolve('react'));
    });
  });
}
