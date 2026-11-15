import 'mocha';
import { expect } from 'chai';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LIFECYCLE_EVENTS } from '@spinajs/http-socket-client';
import type { Manifest, SocketControllerEntry, TypeRef } from '@spinajs/manifest';
import { buildClientModel, generateClientFiles, type GenerateClientFilesOptions } from '../src/index.js';
import { CLIENT_LIFECYCLE_EVENTS, socketHooks } from '../src/generate/hooks/socket.js';
import { appBasicManifest } from './support/fixture.js';
import { typecheckFiles } from './support/typecheck.js';

const source = { line: 1, col: 1, file: 'x.ts', package: 'x' };

function socketController(className: string, prefix: string, events: string[], streams: string[] = []): SocketControllerEntry {
  return {
    id: `x:${className}`,
    className,
    prefix,
    commands: streams.map((name) => ({ name, handler: name, payload: { text: 'string' }, result: { text: 'number' }, stream: true, options: {}, policies: [], source })),
    events: events.map((name) => ({ name, payload: { text: 'string' } })),
    source,
  };
}

const withSockets = (base: Manifest, ...entries: SocketControllerEntry[]): Manifest => ({ ...base, socketControllers: [...base.socketControllers, ...entries] });

async function socketFiles(manifest: Manifest, options: Partial<GenerateClientFilesOptions> = {}): Promise<Record<string, string>> {
  const files = await generateClientFiles({ manifest, hooks: ['react-query', 'swr'], socketHooks: true, ...options });
  return Object.fromEntries(files.map((f) => [f.path, f.contents]));
}

const snapshot = (name: string) => fileURLToPath(new URL(`./__snapshots__/${name}`, import.meta.url));

function matchSnapshot(name: string, contents: string): void {
  if (!existsSync(snapshot(name))) writeFileSync(snapshot(name), contents);
  expect(contents).to.equal(readFileSync(snapshot(name), 'utf8'));
}

const typedApp = [
  "import { SocketClient } from '@spinajs/http-socket-client';",
  "import { chatContract, type ChatMessage } from './client.js';",
  "import { useChatHistoryStream, useChatMessageEvent, type ChatSocket, type SocketStreamState } from './client.socket.js';",
  "import { useChatMessageLatest } from './client.socket-swr.js';",
  '',
  'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;',
  '',
  'export const typed = (client: SocketClient): ChatSocket => client.typed(chatContract);',
  '',
  'export function useChat(socket: ChatSocket): ChatMessage | undefined {',
  '  useChatMessageEvent(socket, (payload) => {',
  '    const exact: Equal<typeof payload, ChatMessage> = true;',
  '    void exact;',
  '  });',
  "  const history: SocketStreamState<ChatMessage> = useChatHistoryStream(socket, { since: '2026-11-01' });",
  '  const items: ChatMessage[] = history.items;',
  '  void items;',
  '  useChatHistoryStream(socket, null);',
  '  // @ts-expect-error the history payload needs since',
  '  useChatHistoryStream(socket, {});',
  '  // @ts-expect-error a message listener does not take a number',
  '  useChatMessageEvent(socket, (payload: number) => payload);',
  '  return useChatMessageLatest(socket).data;',
  '}',
  '',
].join('\n');

describe('socket hooks', () => {
  let manifest: Manifest;
  let files: Record<string, string>;

  before(async () => {
    manifest = await appBasicManifest();
    files = await socketFiles(manifest);
  });

  // Named after the 4.0 snapshot, so the snapshots' imports of `./app-basic.client.js` resolve for the linter.
  it('matches the committed snapshots of client.socket.ts and client.socket-swr.ts', async () => {
    const named = await socketFiles(manifest, { basename: 'app-basic.client' });
    matchSnapshot('app-basic.client.socket.ts', named['app-basic.client.socket.ts']);
    matchSnapshot('app-basic.client.socket-swr.ts', named['app-basic.client.socket-swr.ts']);
  });

  it('writes client.socket.ts for either hooks library and client.socket-swr.ts only with SWR', async () => {
    expect(Object.keys(await socketFiles(manifest, { hooks: ['react-query'] }))).to.deep.equal(['client.ts', 'client.keys.ts', 'client.react.ts', 'client.queries.ts', 'client.react-query.ts', 'client.socket.ts']);
    expect(Object.keys(await socketFiles(manifest, { hooks: ['swr'] }))).to.deep.equal(['client.ts', 'client.keys.ts', 'client.react.ts', 'client.swr.ts', 'client.socket.ts', 'client.socket-swr.ts']);
    expect((await socketFiles(manifest, { hooks: ['react-query'] }))['client.socket.ts']).to.equal(files['client.socket.ts']);
  });

  it('leaves every other file as it is without socketHooks', async () => {
    const without = await socketFiles(manifest, { socketHooks: false });
    expect(Object.keys(without)).to.deep.equal(['client.ts', 'client.keys.ts', 'client.react.ts', 'client.queries.ts', 'client.react-query.ts', 'client.swr.ts']);
    for (const [path, contents] of Object.entries(without)) expect(files[path], path).to.equal(contents);
  });

  for (const react of [18, 19] as const) {
    it(`type-checks with React ${react} types against the socket client, strict and noUnusedLocals, with ChatMessage payloads`, () => {
      expect(typecheckFiles({ ...files, 'app.ts': typedApp }, { noUnusedLocals: true, react })).to.deep.equal([]);
    });
  }

  it('type-checks client.socket-swr.ts against the swr peer floor (2.2.0)', () => {
    expect(typecheckFiles({ ...files, 'app.ts': typedApp }, { noUnusedLocals: true, swr: 'floor' })).to.deep.equal([]);
  });

  it('fails to compile against a client.ts generated from another manifest', () => {
    const stale = files['client.ts'].replace(`manifestHash = '${manifest.hash}'`, "manifestHash = 'other'");
    const errors = typecheckFiles({ ...files, 'client.ts': stale });
    expect(errors.filter((e) => e.startsWith('client.socket.ts: ') || e.startsWith('client.socket-swr.ts: '))).to.have.length(2);
  });

  it('fails to compile when a printed payload type disagrees with the contract', () => {
    const wrong = {
      ...files,
      'client.socket.ts': files['client.socket.ts'].replace('listener: (payload: ChatMessage) => void', 'listener: (payload: number) => void'),
      'client.socket-swr.ts': files['client.socket-swr.ts'].replace('useSWRSubscription<ChatMessage,', 'useSWRSubscription<number,'),
    };
    const errors = typecheckFiles(wrong);
    expect(errors.filter((e) => e.startsWith('client.socket.ts: '))).to.have.length(1);
    expect(errors.filter((e) => e.startsWith('client.socket-swr.ts: ')).length).to.be.greaterThan(0);
  });

  it('names hooks after the contract and the event or command, in PascalCase words', () => {
    const model = buildClientModel(withSockets(manifest, socketController('DocsSocketController', 'doc-room', ['docs.committed', 'user:joined'], ['load_page'])));
    const docs = socketHooks(model).find((c) => c.contract === 'docRoomContract');
    expect(docs?.socketType).to.equal('DocRoomSocket');
    expect(docs?.events.map((e) => [e.hookName, e.latestName])).to.deep.equal([
      ['useDocRoomDocsCommittedEvent', 'useDocRoomDocsCommittedLatest'],
      ['useDocRoomUserJoinedEvent', 'useDocRoomUserJoinedLatest'],
    ]);
    expect(docs?.streams.map((s) => s.hookName)).to.deep.equal(['useDocRoomLoadPageStream']);
  });

  it('type-checks hooks for contracts without events, without streams and with dotted names', async () => {
    const more = await socketFiles(withSockets(manifest, socketController('QuietSocketController', 'quiet', []), socketController('DocsSocketController', 'docs', ['docs.committed'], ['load.page'])));
    expect(more['client.socket.ts']).to.include('export type QuietSocket = ');
    expect(typecheckFiles(more, { noUnusedLocals: true })).to.deep.equal([]);
  });

  it('writes only the hash check, and type-checks, when the manifest has no socket controllers', async () => {
    const none = await socketFiles({ ...manifest, socketControllers: [] });
    expect(none['client.socket.ts']).to.not.include('import { use');
    expect(typecheckFiles(none, { noUnusedLocals: true })).to.deep.equal([]);
  });

  it('refuses two events whose hooks would share a name', () => {
    const model = buildClientModel(withSockets(manifest, socketController('DocsSocketController', 'docs', ['doc.open', 'doc-open'])));
    expect(() => socketHooks(model)).to.throw("generateClientFiles: DocsSocketController event 'doc.open' and DocsSocketController event 'doc-open' would both be useDocsDocOpenEvent; rename one to generate socket hooks, or generate without socketHooks");
  });

  it('refuses a payload type that would take a name the socket hooks declare', () => {
    const shadow = { ...manifest, schemas: { ...manifest.schemas, 'x/SocketStreamState': { type: 'object', properties: { a: { type: 'string' } } } } };
    const entry = socketController('DocsSocketController', 'docs', ['opened']);
    const model = buildClientModel(withSockets(shadow, { ...entry, events: [{ name: 'opened', payload: { text: 'SocketStreamState', schema: 'x/SocketStreamState' } }] }));
    expect(() => socketHooks(model)).to.throw("generateClientFiles: the type SocketStreamState and the socket hooks' own SocketStreamState would share a name in the socket hooks");
  });

  it('knows the same lifecycle event names as the socket client', () => {
    expect([...CLIENT_LIFECYCLE_EVENTS].sort()).to.deep.equal([...LIFECYCLE_EVENTS].sort());
  });

  for (const event of ['failed', 'state', 'held']) {
    it(`refuses a server event named '${event}', which SocketClient.on() routes to its lifecycle listeners`, () => {
      const model = buildClientModel(withSockets(manifest, socketController('DocsSocketController', 'docs', ['opened', event])));
      expect(() => socketHooks(model)).to.throw(`generateClientFiles: DocsSocketController event '${event}' shares its name with a socket client lifecycle event, so SocketClient.on() would never deliver it; rename the event to generate socket hooks, or generate without socketHooks`);
    });
  }

  const nullable: [string, TypeRef, Record<string, unknown>, string][] = [
    ['a payload type that includes null', { text: 'Page', schema: 'x/Page' }, { 'x/Page': { type: ['object', 'null'], properties: { n: { type: 'number' } } } }, 'Page'],
    ['a payload referencing a nullable schema', { text: 'Wrapper', schema: 'x/Wrapper' }, { 'x/Wrapper': { anyOf: [{ $ref: 'x/Inner' }, { type: 'string' }] }, 'x/Inner': { type: 'null' } }, 'Wrapper'],
    ['a payload printed as unknown', { text: 'Mystery' }, {}, 'unknown'],
  ];
  for (const [what, payload, schemas, printed] of nullable) {
    it(`refuses a stream hook for ${what}, because null turns the hook off`, () => {
      const entry = socketController('DocsSocketController', 'docs', [], ['load']);
      const commands = entry.commands.map((c) => ({ ...c, payload }));
      const model = buildClientModel(withSockets({ ...manifest, schemas: { ...manifest.schemas, ...schemas } }, { ...entry, commands }));
      expect(() => socketHooks(model)).to.throw(`generateClientFiles: DocsSocketController stream 'load' takes a payload typed ${printed}, which allows null, but null turns a stream hook off; give the payload a type without null to generate socket hooks, or generate without socketHooks`);
    });
  }

  it('keeps a stream hook for a payload with a nullable property', () => {
    const entry = socketController('DocsSocketController', 'docs', [], ['load']);
    const schemas = { ...manifest.schemas, 'x/Query': { type: 'object', properties: { cursor: { type: ['string', 'null'] } } } };
    const commands = entry.commands.map((c) => ({ ...c, payload: { text: 'Query', schema: 'x/Query' } }));
    const model = buildClientModel(withSockets({ ...manifest, schemas }, { ...entry, commands }));
    expect(socketHooks(model).find((c) => c.contract === 'docsContract')?.streams.map((st) => st.hookName)).to.deep.equal(['useDocsLoadStream']);
  });

  it('refuses socketHooks when includeSocket leaves the contracts out', async () => {
    const error = await generateClientFiles({ manifest, hooks: ['swr'], socketHooks: true, includeSocket: false }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((error as Error).message).to.equal('generateClientFiles: socketHooks needs the socket contracts, which includeSocket: false leaves out of client.ts');
  });
});
